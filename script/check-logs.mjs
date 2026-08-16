// Does eth_getLogs work on this endpoint, for this deployment?
//
// This exists because `npm run check` could read every deal by id and still tell you nothing
// about the one thing that was broken. The app does not know the ids: it discovers deals by
// scanning DealFunded events. So a chain where every getDeal call succeeds can still produce an
// empty loan list, and reading deals by id proves the wrong thing.
//
// This runs the same scan the browser runs, over the same range, with the same chunking and the
// same fallback. If it finds events, the frontend will too. If it does not, the endpoint is the
// problem and no amount of frontend work will help.
//
//   node script/check-logs.mjs
//
// Reads XLAYER_TESTNET_RPC_URL, DEAL_MANAGER_ADDRESS and DEPLOY_BLOCK from the environment.

import { ethers } from "ethers";

const RPC = process.env.XLAYER_TESTNET_RPC_URL || "https://testrpc.xlayer.tech/terigon";
const DEAL_MANAGER = process.env.DEAL_MANAGER_ADDRESS;
const FROM = Number(process.env.DEPLOY_BLOCK || 0);

const EVENTS = [
  "event DealFunded(bytes32 indexed dealId, address indexed borrower, address indexed underwriter, uint256 principal, uint256 dueAmount, uint256 avalLocked, uint16 pdBps)",
  "event AttestationAnchored(bytes32 indexed dealId, address indexed underwriter, uint16 pdBps, uint16 pdUpperBps, uint16 advanceRateBps, bytes32 modelCommit, bytes32 featureHash, bytes32 rationaleCID)",
  "event Settled(bytes32 indexed dealId, bool defaulted, uint256 repaid, uint256 slashed, uint256 feePaid, uint256 feeForfeited)",
];

const CHUNK = 9_000;

if (!DEAL_MANAGER) {
  console.error("DEAL_MANAGER_ADDRESS is not set");
  process.exit(2);
}

const provider = new ethers.JsonRpcProvider(RPC);
const iface = new ethers.Interface(EVENTS);

/** Same adaptive walk as web/lib/aval.ts: halve the window whenever the endpoint refuses it. */
async function walk(topics, head) {
  const out = [];
  let start = Math.max(0, FROM);
  let size = CHUNK;
  let refusals = 0;

  while (start <= head) {
    const end = Math.min(start + size - 1, head);
    try {
      const logs = await provider.getLogs({ address: DEAL_MANAGER, fromBlock: start, toBlock: end, topics });
      out.push(...logs);
      start = end + 1;
      if (size < CHUNK) size = Math.min(CHUNK, size * 2);
    } catch (err) {
      refusals++;
      if (size <= 1) throw err;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
  return { logs: out, refusals };
}

const head = await provider.getBlockNumber();
console.log(`  scanning ${FROM.toLocaleString("en-US")} to ${head.toLocaleString("en-US")} in chunks of ${CHUNK}`);

let total = 0;
let refusals = 0;
const counts = {};

for (const sig of EVENTS) {
  const frag = ethers.EventFragment.from(sig.replace(/^event /, ""));
  const r = await walk([frag.topicHash], head);
  counts[frag.name] = r.logs.length;
  total += r.logs.length;
  refusals += r.refusals;
}

// Same last resort the browser uses: some endpoints answer an address-only query with an empty
// array instead of an error, so a filtered pass returning nothing is suspicious, not conclusive.
let unfiltered = 0;
if (total === 0) {
  const r = await walk(undefined, head);
  unfiltered = r.logs.length;
  for (const log of r.logs) {
    try {
      const p = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (p) counts[p.name] = (counts[p.name] ?? 0) + 1;
    } catch {
      /* an event this script does not know */
    }
  }
}

for (const [name, n] of Object.entries(counts)) console.log(`  ${name.padEnd(22)} ${n}`);
if (refusals > 0) console.log(`  the endpoint refused ${refusals} window(s) and the scan halved and retried`);

const funded = counts.DealFunded ?? 0;
if (funded > 0) {
  console.log(`\nOK ${funded} DealFunded event(s). The app will see these loans.`);
  process.exit(0);
}

if (unfiltered > 0) {
  console.log("\nFAIL the filtered scan found nothing but an unfiltered one did.");
  console.log("     This endpoint mishandles topic filters. Use a different XLAYER_TESTNET_RPC_URL.");
  process.exit(1);
}

console.log("\nFAIL no DealFunded events in that range.");
console.log("     If the pool reports assets deployed, they cannot both be true: deployTo is");
console.log("     onlyDealManager and fundDeal emits DealFunded on the next line. That means the");
console.log("     endpoint is not returning logs, so try a different XLAYER_TESTNET_RPC_URL.");
console.log("     If the pool is empty, nothing has been funded yet and there is nothing to see.");
process.exit(1);
