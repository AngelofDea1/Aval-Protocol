// Cashflow adapter tests.
//
//   node test/js/adapters.test.mjs

import { compile, newChain, wallet, ethers } from "./harness.mjs";

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    passed++;
    console.log(`    ok  ${label}`);
  } else {
    failed++;
    console.log(`   FAIL ${label}\n         expected: ${expected}\n         actual:   ${actual}`);
  }
}

const artifacts = compile();

// ------------------------------------------------------- protocol revenue

console.log("\n  ProtocolRevenueAdapter");
{
  const chain = await newChain(artifacts);
  const owner = wallet(0);
  const reporter = wallet(1);
  const stranger = wallet(2);
  for (const a of [owner, reporter, stranger]) await chain.fund(a.address);

  const adapter = await chain.deploy("ProtocolRevenueAdapter", [owner.hex], owner.address);
  const obligorId = await adapter.call("obligorIdFor", ["uniswap"]);
  check("obligor id is keccak of the slug", obligorId, ethers.keccak256(ethers.toUtf8Bytes("uniswap")));

  check("unregistered obligor is ineligible", await adapter.call("isEligible", [obligorId]), false);

  await adapter.send(
    "registerObligor",
    [obligorId, ethers.keccak256(ethers.toUtf8Bytes("defillama:uniswap")), "Uniswap"],
    owner.address
  );
  check("registered obligor is eligible", await adapter.call("isEligible", [obligorId]), true);

  const dealId = ethers.keccak256(ethers.toUtf8Bytes("deal-1"));

  check(
    "a stranger cannot link deals",
    await adapter.expectRevert("linkDeal", [dealId, obligorId], stranger.address),
    "NotReporter()"
  );

  await adapter.send("setReporter", [reporter.hex, true], owner.address);
  await adapter.send("linkDeal", [dealId, obligorId], reporter.address);
  check("deal links to obligor", await adapter.call("dealObligor", [dealId]), obligorId);
  check(
    "a deal cannot be relinked",
    await adapter.expectRevert("linkDeal", [dealId, obligorId], reporter.address),
    "DealAlreadyLinked()"
  );

  await adapter.send("reportInflow", [dealId, 5_000n], reporter.address);
  check("inflow recorded", await adapter.call("observedInflow", [dealId]), 5_000n);

  await adapter.send("reportInflow", [dealId, 12_000n], reporter.address);
  check("inflow accumulates", await adapter.call("observedInflow", [dealId]), 12_000n);

  // Monotonicity means a bad report can only be corrected upward, and visibly.
  check(
    "cumulative inflow cannot be walked back",
    await adapter.expectRevert("reportInflow", [dealId, 11_999n], reporter.address),
    "InflowMustNotDecrease()"
  );

  check(
    "unknown obligor cannot be linked",
    await adapter.expectRevert(
      "linkDeal",
      [ethers.keccak256(ethers.toUtf8Bytes("deal-2")), ethers.keccak256(ethers.toUtf8Bytes("ghost"))],
      reporter.address
    ),
    "UnknownObligor()"
  );

  await adapter.send("deregisterObligor", [obligorId], owner.address);
  check("deregistered obligor is ineligible", await adapter.call("isEligible", [obligorId]), false);
}

// ---------------------------------------------------------------- invoice

console.log("\n  InvoiceAdapter");
{
  const chain = await newChain(artifacts);
  const owner = wallet(0);
  const reporter = wallet(1);
  for (const a of [owner, reporter]) await chain.fund(a.address);

  const adapter = await chain.deploy("InvoiceAdapter", [owner.hex], owner.address);
  await adapter.send("setReporter", [reporter.hex, true], owner.address);

  const buyer = ethers.keccak256(ethers.toUtf8Bytes("buyer:acme-corp"));
  const dealId = ethers.keccak256(ethers.toUtf8Bytes("inv-1"));
  const doc = ethers.keccak256(ethers.toUtf8Bytes("invoice-pdf-bytes"));

  check(
    "cannot record against an unapproved buyer",
    await adapter.expectRevert("recordInvoice", [dealId, buyer, 50_000n, 1_790_000_000, doc], reporter.address),
    "BuyerNotApproved()"
  );

  await adapter.send("setBuyerApproved", [buyer, true], owner.address);
  await adapter.send("recordInvoice", [dealId, buyer, 50_000n, 1_790_000_000, doc], reporter.address);

  const inv = await adapter.call("invoices", [dealId]);
  check("invoice recorded", inv.faceAmount, 50_000n);
  check("document hash stored", inv.documentHash, doc);
  check("not settled on record", inv.settled, false);

  check(
    "cannot record the same invoice twice",
    await adapter.expectRevert("recordInvoice", [dealId, buyer, 50_000n, 1_790_000_000, doc], reporter.address),
    "InvoiceExists()"
  );

  await adapter.send("reportCollection", [dealId, 20_000n], reporter.address);
  check("partial collection tracked", await adapter.call("observedInflow", [dealId]), 20_000n);
  check("still unsettled while short", (await adapter.call("invoices", [dealId])).settled, false);

  check(
    "collection cannot decrease",
    await adapter.expectRevert("reportCollection", [dealId, 19_999n], reporter.address),
    "CollectionMustNotDecrease()"
  );

  await adapter.send("reportCollection", [dealId, 50_000n], reporter.address);
  check("settles when face amount is reached", (await adapter.call("invoices", [dealId])).settled, true);

  check(
    "unknown invoice reverts",
    await adapter.expectRevert(
      "reportCollection",
      [ethers.keccak256(ethers.toUtf8Bytes("nope")), 1n],
      reporter.address
    ),
    "UnknownInvoice()"
  );
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
