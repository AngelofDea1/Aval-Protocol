import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { UnderwritingModel } from "@/lib/underwriting/model.mjs";
import { buildFeatures } from "@/lib/underwriting/features.mjs";
import { priceDeal } from "@/lib/underwriting/pricing.mjs";
import { fetchFeeSeries, obligorAgeDays, temporalConcentration } from "@/lib/underwriting/defillama.mjs";
import artifact from "@/lib/underwriting/model.json";
import { CONTRACTS, NETWORK, IS_MAINNET } from "@/lib/facts";

/**
 * The AI underwriter, as an endpoint.
 *
 * It prices a borrower, then signs an EIP-712 attestation with the underwriter's key so the
 * browser can hand that signature to `fundDeal` and take the loan out itself. The signature is
 * the whole product: it is the model accepting liability, and `DealManager` will lock the
 * signer's bond against it.
 *
 * ---------------------------------------------------------------------------------------
 * READ THIS BEFORE ENABLING IT ANYWHERE THAT MATTERS
 *
 * `fundDeal` never checks that the borrower has anything to do with the revenue being scored.
 * The underwriter's signature is the only gate. So an endpoint that signs for whatever borrower
 * the caller sends is, by construction, an open invitation: anybody can price a loan against
 * Uniswap's revenue, receive the principal into their own wallet, and never repay. The bond and
 * the vault's utilisation cap are the only limits.
 *
 * That is the same shape as SECURITY.md finding 1, reachable with an HTTP request instead of
 * mempool observation. On testnet against MockUSDT it costs nothing and demonstrates the
 * mechanism honestly. Against real USDT it drains the vault.
 *
 * Hence the hard refusal below. It is a `return`, not a comment, for the same reason
 * `Seed.s.sol` refuses chain 196 in code: a warning nobody reads is not a control.
 * ---------------------------------------------------------------------------------------
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bounds a mistake. Nothing about the demo needs more than this. */
const MAX_FACE_USDT = 100_000;
const MIN_FACE_USDT = 1_000;

/** Short by design: a stale credit opinion is a liability, and the bond is the signer's. */
const ATTESTATION_TTL_SECONDS = 900;

/** Fifteen minutes, so a loan can be funded, matured and settled inside one sitting. */
const TERM_SECONDS = 15 * 60;
const GRACE_SECONDS = 0;

/** DealManager.maxPdUpperBps on the live deployment. Checked again onchain before signing. */
const FALLBACK_MAX_PD_UPPER_BPS = 3_000;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

const DEAL_MANAGER_ABI = [
  "function maxPdUpperBps() view returns (uint16)",
  "function firstLossBps() view returns (uint16)",
  "function minPrincipal() view returns (uint256)",
  "function paused() view returns (bool)",
  "function registry() view returns (address)",
];

const REGISTRY_ABI = [
  "function getUnderwriter(address) view returns (tuple(bool active,uint32 modelVersion,uint64 registeredAt,bytes32 modelCommit,uint256 bondTotal,uint256 bondLocked,uint256 withdrawRequested,uint64 withdrawUnlockAt))",
];

/** Field order MUST match AvalAttestation.Attestation. Consensus-critical. */
const ATTESTATION_TYPES = {
  Attestation: [
    { name: "dealId", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "underwriter", type: "address" },
    { name: "pdBps", type: "uint16" },
    { name: "pdUpperBps", type: "uint16" },
    { name: "advanceRateBps", type: "uint16" },
    { name: "modelCommit", type: "bytes32" },
    { name: "featureHash", type: "bytes32" },
    { name: "rationaleCID", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
};

/** Mirror of DealManager.hashTerms. One field out of order and every fund reverts. */
function hashTerms(p: {
  dealId: string;
  borrower: string;
  adapter: string;
  principal: bigint;
  discountBps: number;
  maturity: number;
  gracePeriod: number;
}) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint64", "uint64"],
      [p.dealId, p.borrower, p.adapter, p.principal, p.discountBps, p.maturity, p.gracePeriod]
    )
  );
}

export async function POST(req: Request) {
  // ------------------------------------------------------------------ refusals
  if (IS_MAINNET) {
    return json(
      {
        error:
          "Underwriting from the browser is disabled on mainnet. The contract does not tie a " +
          "borrower to the revenue being scored, so an open endpoint would let anyone borrow " +
          "against someone else's business. See SECURITY.md.",
      },
      403
    );
  }

  const key = process.env.UNDERWRITER_PRIVATE_KEY;
  if (!key) {
    return json({ error: "This deployment has no underwriter key configured, so it cannot sign." }, 503);
  }

  let body: { slug?: unknown; face?: unknown; borrower?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const face = Number(body.face);
  const borrower = typeof body.borrower === "string" ? body.borrower.trim() : "";

  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) return json({ error: "Choose a business first." }, 400);
  if (!ethers.isAddress(borrower)) return json({ error: "That is not a valid wallet address." }, 400);
  if (!Number.isFinite(face) || face < MIN_FACE_USDT || face > MAX_FACE_USDT) {
    return json(
      { error: `Amount must be between ${MIN_FACE_USDT.toLocaleString("en-US")} and ${MAX_FACE_USDT.toLocaleString("en-US")} USDT.` },
      400
    );
  }

  // ------------------------------------------------------------------ price it
  let series;
  try {
    series = await fetchFeeSeries(slug);
  } catch {
    return json({ error: `No revenue history found for "${slug}".` }, 404);
  }
  const values: number[] = series.values;
  if (values.length < 30) {
    return json({ error: `Only ${values.length} days of revenue history. The model needs at least 30.` }, 422);
  }

  const model = new UnderwritingModel(artifact);
  const dueAmountGuess = face; // refined below once the discount is known
  const feats = buildFeatures(values, {
    concentration: temporalConcentration(values),
    obligorAgeDays: obligorAgeDays(series),
    dueAmount: dueAmountGuess,
    horizonDays: 30,
  });

  const prediction = model.predict(feats);
  const pdBps = Math.round(prediction.pd * 10_000);
  const pdUpperBps = Math.round(prediction.pdUpper * 10_000);
  const pricing = priceDeal({ pd: prediction.pd, pdUpper: prediction.pdUpper });

  // ------------------------------------------------- check policy against the chain
  const provider = new ethers.JsonRpcProvider(NETWORK.rpc);
  const dm = new ethers.Contract(CONTRACTS.dealManager, DEAL_MANAGER_ABI, provider);

  let maxPdUpperBps = FALLBACK_MAX_PD_UPPER_BPS;
  let firstLossBps = 1_500;
  let minPrincipal = 0n;
  try {
    if (await dm.paused()) return json({ error: "New lending is paused on the protocol right now." }, 409);
    maxPdUpperBps = Number(await dm.maxPdUpperBps());
    firstLossBps = Number(await dm.firstLossBps());
    minPrincipal = await dm.minPrincipal();
  } catch {
    return json({ error: "Could not read the protocol's limits from the chain. Try again." }, 502);
  }

  if (pdUpperBps > maxPdUpperBps) {
    return json(
      {
        error: `The AI will not underwrite this. Its worst case is ${(pdUpperBps / 100).toFixed(2)}%, above the protocol ceiling of ${maxPdUpperBps / 100}%.`,
        pdBps,
        pdUpperBps,
        fundable: false,
      },
      422
    );
  }

  const principal = BigInt(Math.floor((face * pricing.advanceRateBps) / 10_000)) * 1_000_000n;
  if (principal < minPrincipal) {
    return json({ error: "That advance is below the protocol's minimum loan size." }, 422);
  }

  // ------------------------------------------- does the underwriter have free bond?
  const signer = new ethers.Wallet(key);
  try {
    const registry = new ethers.Contract(await dm.registry(), REGISTRY_ABI, provider);
    const u = await registry.getUnderwriter(signer.address);
    if (!u.active) return json({ error: "The AI underwriter is not registered on this deployment." }, 409);
    const required = (principal * BigInt(firstLossBps)) / 10_000n;
    const free = BigInt(u.bondTotal) - BigInt(u.bondLocked);
    if (free < required) {
      return json(
        {
          error:
            `The AI does not have enough free collateral for this loan. It needs ` +
            `${(Number(required) / 1e6).toFixed(2)} USDT and has ${(Number(free) / 1e6).toFixed(2)} free. ` +
            `Try a smaller amount.`,
        },
        409
      );
    }
  } catch {
    return json({ error: "Could not read the underwriter's bond from the chain. Try again." }, 502);
  }

  // ------------------------------------------------------------------- sign it
  const now = Math.floor(Date.now() / 1000);
  const dealParams = {
    // Random, so two people pricing the same business at the same second cannot collide on a
    // dealId and have the second fund revert with DealExists.
    dealId: ethers.hexlify(ethers.randomBytes(32)),
    borrower,
    adapter: process.env.ADAPTER_ADDRESS ?? ethers.ZeroAddress,
    principal,
    discountBps: pricing.discountBps,
    maturity: now + TERM_SECONDS,
    gracePeriod: GRACE_SECONDS,
  };

  const attestation = {
    dealId: dealParams.dealId,
    termsHash: hashTerms(dealParams),
    underwriter: signer.address,
    pdBps,
    pdUpperBps,
    advanceRateBps: pricing.advanceRateBps,
    modelCommit: ethers.id(model.version),
    featureHash: ethers.id(JSON.stringify(feats)),
    rationaleCID: ethers.ZeroHash,
    issuedAt: now,
    expiresAt: now + ATTESTATION_TTL_SECONDS,
  };

  const domain = {
    name: "AvalProtocol",
    version: "1",
    chainId: NETWORK.chainId,
    verifyingContract: CONTRACTS.dealManager,
  };

  const signature = await signer.signTypedData(domain, ATTESTATION_TYPES, attestation);

  // Verify our own signature before handing it over. A signature that does not recover produces
  // an opaque BadSigner revert in the user's wallet, which tells them nothing.
  const recovered = ethers.verifyTypedData(domain, ATTESTATION_TYPES, attestation, signature);
  if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
    return json({ error: "The AI produced a signature that does not verify. Nothing was signed." }, 500);
  }

  const due = (principal * BigInt(10_000 + pricing.discountBps)) / 10_000n;

  return json({
    fundable: true,

    // Everything the browser needs to call fundDeal, as strings so BigInt survives JSON.
    dealParams: { ...dealParams, principal: principal.toString() },
    attestation: { ...attestation },
    signature,

    // And everything a person needs to decide, in units they read.
    summary: {
      business: slug,
      requested: face,
      youReceive: Number(principal) / 1e6,
      youRepay: Number(due) / 1e6,
      advanceRateBps: pricing.advanceRateBps,
      discountBps: pricing.discountBps,
      pdBps,
      pdUpperBps,
      aiStakes: Number((principal * BigInt(firstLossBps)) / 10_000n) / 1e6,
      termMinutes: TERM_SECONDS / 60,
      underwriter: signer.address,
      modelVersion: model.version,
      expiresAt: attestation.expiresAt,
    },
  });
}
