#!/usr/bin/env node
/**
 * Verify /api/agent against the live deployment.
 *
 * The agent manifest publishes economic constants that an outside agent will build
 * transactions against. Every one of them is owner-adjustable onchain, so a manifest that was
 * accurate at deploy time can quietly stop being accurate without anything failing. An agent
 * that trusts a stale maxPdUpperBps signs an attestation that reverts, and the reason is
 * invisible from its side.
 *
 * This is the check that catches that. Run it after any parameter change, and before
 * submitting or demoing.
 *
 *   node script/verify-manifest.mjs
 *   node script/verify-manifest.mjs --rpc https://... --deal-manager 0x...
 *
 * Exits non-zero on any mismatch, so it can gate a deploy.
 */

import { ethers } from "ethers";

/* ------------------------------------------------------------------- config */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const RPC = arg("rpc", process.env.RPC_URL || "https://testrpc.xlayer.tech/terigon");
const CHAIN_ID = Number(arg("chain-id", process.env.CHAIN_ID || 1952));
const DEAL_MANAGER = arg("deal-manager", process.env.DEAL_MANAGER || "0x0f9bF65cb7f2549EA41012A9D692986bE633d52F");

/**
 * What web/lib/agent-manifest.ts publishes.
 *
 * Duplicated deliberately. If this file imported the manifest, the two would always agree and
 * the check would prove nothing. The point is that an independent statement of the values is
 * compared against the chain.
 */
const MANIFEST_CLAIMS = {
  firstLossBps: 1500,
  underwriterFeeBps: 100,
  maxPdUpperBps: 3000,
  minPrincipal: 1_000_000n,
  maxTermSeconds: 31_536_000n,
  maxGraceSeconds: 7_776_000n,
  maxUtilizationBps: 8000,
  bondWithdrawCooldownSeconds: 604_800n,
  assetDecimals: 6,
};

/** Field order here is consensus-critical; it must match AvalAttestation.Attestation. */
const ATTESTATION_TYPE_STRING =
  "Attestation(bytes32 dealId,bytes32 termsHash,address underwriter,uint16 pdBps,uint16 pdUpperBps," +
  "uint16 advanceRateBps,bytes32 modelCommit,bytes32 featureHash,bytes32 rationaleCID," +
  "uint64 issuedAt,uint64 expiresAt)";

/* -------------------------------------------------------------------- check */

const ABI = {
  dealManager: [
    "function firstLossBps() view returns (uint16)",
    "function underwriterFeeBps() view returns (uint16)",
    "function maxPdUpperBps() view returns (uint16)",
    "function minPrincipal() view returns (uint256)",
    "function maxTermSeconds() view returns (uint64)",
    "function maxGraceSeconds() view returns (uint64)",
    "function registry() view returns (address)",
    "function reputation() view returns (address)",
    "function vault() view returns (address)",
    "function asset() view returns (address)",
  ],
  vault: ["function maxUtilizationBps() view returns (uint16)"],
  registry: ["function WITHDRAW_COOLDOWN() view returns (uint64)"],
  erc20: ["function decimals() view returns (uint8)"],
};

let failures = 0;

function check(label, claimed, actual) {
  const ok = String(claimed) === String(actual);
  if (!ok) failures++;
  const mark = ok ? "  ok  " : " FAIL ";
  console.log(`${mark} ${label.padEnd(30)} manifest=${String(claimed).padEnd(12)} chain=${actual}`);
}

async function main() {
  console.log(`\nVerifying agent manifest against ${RPC}\n`);

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const net = await provider.getNetwork();
  check("chainId", CHAIN_ID, Number(net.chainId));

  const dm = new ethers.Contract(DEAL_MANAGER, ABI.dealManager, provider);

  // Discover the rest from the DealManager rather than hardcoding, so a manifest pointing at
  // a stale vault or registry is caught rather than silently believed.
  const [vaultAddr, registryAddr, assetAddr] = await Promise.all([dm.vault(), dm.registry(), dm.asset()]);

  const vault = new ethers.Contract(vaultAddr, ABI.vault, provider);
  const registry = new ethers.Contract(registryAddr, ABI.registry, provider);
  const asset = new ethers.Contract(assetAddr, ABI.erc20, provider);

  check("firstLossBps", MANIFEST_CLAIMS.firstLossBps, Number(await dm.firstLossBps()));
  check("underwriterFeeBps", MANIFEST_CLAIMS.underwriterFeeBps, Number(await dm.underwriterFeeBps()));
  check("maxPdUpperBps", MANIFEST_CLAIMS.maxPdUpperBps, Number(await dm.maxPdUpperBps()));
  check("minPrincipal", MANIFEST_CLAIMS.minPrincipal, await dm.minPrincipal());
  check("maxTermSeconds", MANIFEST_CLAIMS.maxTermSeconds, await dm.maxTermSeconds());
  check("maxGraceSeconds", MANIFEST_CLAIMS.maxGraceSeconds, await dm.maxGraceSeconds());
  check("maxUtilizationBps", MANIFEST_CLAIMS.maxUtilizationBps, Number(await vault.maxUtilizationBps()));
  check("bondWithdrawCooldown", MANIFEST_CLAIMS.bondWithdrawCooldownSeconds, await registry.WITHDRAW_COOLDOWN());
  check("asset decimals", MANIFEST_CLAIMS.assetDecimals, Number(await asset.decimals()));

  console.log("\nWiring, read from DealManager itself:");
  console.log(`       vault            ${vaultAddr}`);
  console.log(`       registry         ${registryAddr}`);
  console.log(`       reputation       ${await dm.reputation()}`);
  console.log(`       asset            ${assetAddr}`);
  console.log("\n  Confirm these match the `contracts` block of the manifest.");

  console.log(`\nATTESTATION_TYPEHASH\n       ${ethers.keccak256(ethers.toUtf8Bytes(ATTESTATION_TYPE_STRING))}`);
  console.log("  Must equal AvalAttestation.ATTESTATION_TYPEHASH. If it does not, every");
  console.log("  fundDeal call from an external agent reverts with BadSigner.");

  if (failures === 0) {
    console.log("\nEvery published constant matches the live deployment.\n");
  } else {
    console.log(`\n${failures} mismatch(es). The manifest is lying to integrating agents. Fix before demo.\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("\nCould not complete the check:", e.shortMessage || e.message);
  process.exitCode = 1;
});
