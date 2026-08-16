// Minimal in-process EVM harness (pure JS, no native bindings).
//
// `forge test` is the primary test path for this repo. This harness exists so the full
// deal lifecycle can also be executed in environments where the Foundry toolchain and
// solc binaries are unreachable. It runs the same compiled artifacts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";
import { createVM } from "@ethereumjs/vm";
import { Common, Mainnet, Hardfork } from "@ethereumjs/common";
import { Address, createAccount, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");

// OZ may live in the repo or in an external module dir (see NODE_PATH), so probe both.
const MODULE_DIRS = [
  path.join(ROOT, "node_modules"),
  ...(process.env.NODE_PATH ?? "").split(":").filter(Boolean),
];

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith(".sol")) acc.push(full);
  }
  return acc;
}

export function compile() {
  const sources = {};
  for (const f of walk(SRC)) sources[path.relative(ROOT, f)] = { content: fs.readFileSync(f, "utf8") };

  const findImports = (p) => {
    const candidates = [path.join(ROOT, p), ...MODULE_DIRS.map((m) => path.join(m, p))];
    for (const c of candidates) if (fs.existsSync(c)) return { contents: fs.readFileSync(c, "utf8") };
    return { error: `Not found: ${p}` };
  };

  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources,
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
      { import: findImports }
    )
  );

  const errs = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errs.length) {
    errs.forEach((e) => console.error(e.formattedMessage));
    throw new Error("compilation failed");
  }

  const byName = {};
  for (const contracts of Object.values(out.contracts ?? {})) {
    for (const [name, c] of Object.entries(contracts)) {
      if (c.evm.bytecode.object) byName[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
    }
  }
  return byName;
}

/// Mutable block context so tests can advance time.
class Chain {
  constructor(vm, artifacts) {
    this.vm = vm;
    this.artifacts = artifacts;
    this.timestamp = 1_780_000_000n;
    this.number = 1n;
    this.errorAbis = [];
  }

  get block() {
    const self = this;
    return {
      header: {
        get number() {
          return self.number;
        },
        get timestamp() {
          return self.timestamp;
        },
        coinbase: new Address(hexToBytes("0x" + "00".repeat(20))),
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        gasLimit: 30_000_000n,
        baseFeePerGas: 0n,
        getBlobGasPrice: () => 0n,
      },
    };
  }

  warp(seconds) {
    this.timestamp += BigInt(seconds);
    this.number += 1n;
  }

  async fund(address, wei = 10n ** 24n) {
    await this.vm.stateManager.putAccount(address, createAccount({ balance: wei, nonce: 0n }));
  }

  _decodeRevert(returnValue) {
    const hex = bytesToHex(returnValue);
    if (!hex || hex === "0x") return "revert (no data)";
    for (const abi of this.errorAbis) {
      try {
        const iface = new ethers.Interface(abi);
        const parsed = iface.parseError(hex);
        if (parsed) return `${parsed.name}(${parsed.args.map(String).join(",")})`;
      } catch {}
    }
    try {
      return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + hex.slice(10))[0];
    } catch {
      return `revert ${hex.slice(0, 74)}`;
    }
  }

  async deploy(name, args = [], from) {
    const art = this.artifacts[name];
    if (!art) throw new Error(`unknown contract ${name}`);
    this.errorAbis.push(art.abi);
    const iface = new ethers.Interface(art.abi);
    const encodedArgs = iface.encodeDeploy(args);
    const data = hexToBytes(art.bytecode + encodedArgs.slice(2));

    const res = await this.vm.evm.runCall({
      caller: from,
      to: undefined,
      data,
      gasLimit: 30_000_000n,
      value: 0n,
      block: this.block,
    });
    if (res.execResult.exceptionError) {
      throw new Error(`deploy ${name} failed: ${res.execResult.exceptionError.error}`);
    }
    // runCall does not bump the deployer nonce, so do it to keep CREATE addresses unique.
    const acct = await this.vm.stateManager.getAccount(from);
    acct.nonce += 1n;
    await this.vm.stateManager.putAccount(from, acct);

    return new Contract(this, res.createdAddress, art.abi, name);
  }
}

class Contract {
  constructor(chain, address, abi, name) {
    this.chain = chain;
    this.address = address;
    this.abi = abi;
    this.name = name;
    this.iface = new ethers.Interface(abi);
  }

  get hexAddress() {
    return this.address.toString();
  }

  async _run(fn, args, from, value = 0n) {
    const data = hexToBytes(this.iface.encodeFunctionData(fn, args));
    return this.chain.vm.evm.runCall({
      caller: from,
      to: this.address,
      data,
      gasLimit: 30_000_000n,
      value,
      block: this.chain.block,
    });
  }

  /// State-changing call. Throws with a decoded custom-error name on revert.
  async send(fn, args = [], from, value = 0n) {
    const res = await this._run(fn, args, from, value);
    if (res.execResult.exceptionError) {
      const reason = this.chain._decodeRevert(res.execResult.returnValue);
      throw new Error(`${this.name}.${fn} reverted: ${reason}`);
    }
    return res;
  }

  /// Expects a revert; returns the decoded reason.
  async expectRevert(fn, args = [], from) {
    const res = await this._run(fn, args, from);
    if (!res.execResult.exceptionError) throw new Error(`${this.name}.${fn} was expected to revert but did not`);
    return this.chain._decodeRevert(res.execResult.returnValue);
  }

  /// Read-only call.
  async call(fn, args = [], from) {
    const res = await this._run(fn, args, from ?? this.address);
    if (res.execResult.exceptionError) {
      throw new Error(`${this.name}.${fn} reverted: ${this.chain._decodeRevert(res.execResult.returnValue)}`);
    }
    const decoded = this.iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue));
    return decoded.length === 1 ? decoded[0] : decoded;
  }
}

export async function newChain(artifacts) {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  return new Chain(vm, artifacts);
}

export function wallet(index) {
  const w = new ethers.Wallet(ethers.zeroPadValue(ethers.toBeHex(index + 1), 32));
  return { wallet: w, address: new Address(hexToBytes(w.address.toLowerCase())), hex: w.address };
}

export { Address, hexToBytes, bytesToHex, ethers };
