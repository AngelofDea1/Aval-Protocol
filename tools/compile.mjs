// Standalone solc compile + artifact dump.
//
// The repo is a normal Foundry project; this exists so the contracts can be verified
// without the Foundry toolchain (useful in restricted CI/sandbox environments where
// binaries.soliditylang.org is unreachable). `forge build` remains the primary path.
//
//   node tools/compile.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SRC = path.join(root, "src");
const OUT = path.join(root, "out-solc");

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".sol")) acc.push(full);
  }
  return acc;
}

function resolveImport(importPath) {
  const candidates = importPath.startsWith("@")
    ? [path.join(root, "node_modules", importPath)]
    : [path.join(SRC, importPath), path.join(root, importPath)];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const sources = {};
for (const file of walk(SRC)) {
  sources[path.relative(root, file)] = { content: fs.readFileSync(file, "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const findImports = (importPath) => {
  // Relative imports arrive already normalised against the importing file by solc.
  const direct = path.join(root, importPath);
  if (fs.existsSync(direct)) return { contents: fs.readFileSync(direct, "utf8") };
  const resolved = resolveImport(importPath);
  if (resolved) return { contents: fs.readFileSync(resolved, "utf8") };
  return { error: `Not found: ${importPath}` };
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let errors = 0;
let warnings = 0;
for (const e of output.errors ?? []) {
  if (e.severity === "error") {
    errors++;
    console.error(e.formattedMessage);
  } else {
    warnings++;
    console.warn(e.formattedMessage);
  }
}

if (errors > 0) {
  console.error(`\nFAILED: ${errors} error(s), ${warnings} warning(s)`);
  process.exit(1);
}

// Overwrite in place rather than wiping the directory: some mounted filesystems refuse
// unlink, and a stale artifact is a much smaller problem than a build that cannot run.
try {
  fs.rmSync(OUT, { recursive: true, force: true });
} catch {}
fs.mkdirSync(OUT, { recursive: true });

const summary = [];
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [name, c] of Object.entries(contracts)) {
    const size = c.evm.deployedBytecode.object.length / 2;
    summary.push({ name, file, bytes: size });
    fs.writeFileSync(
      path.join(OUT, `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: c.evm.bytecode.object }, null, 2)
    );
  }
}

summary.sort((a, b) => b.bytes - a.bytes);
console.log(`\nCompiled ${summary.length} contracts with solc ${solc.version()}`);
console.log(`${warnings} warning(s)\n`);
for (const s of summary) {
  const flag = s.bytes > 24576 ? "  << EXCEEDS EIP-170 LIMIT" : "";
  console.log(`  ${String(s.bytes).padStart(6)} B  ${s.name}${flag}`);
}
console.log(`\nArtifacts -> ${path.relative(root, OUT)}/`);
