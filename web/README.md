# Aval web

Next.js 16 front end for Aval Protocol.

| Route | What it is |
|---|---|
| `/` | What the protocol does and who it is for |
| `/protocol` | The three mechanisms, and a worked example of a default |
| `/model` | The three model stages and the walk-forward results |
| `/developers` | Quickstart, the attestation schema, contract addresses |
| `/app` | The working app: lend, borrow, browse loans, compare model records |
| `/terms`, `/privacy` | Written to describe this deployment, not from boilerplate |

Two machine-readable endpoints, for agents rather than people:

| Route | What it is |
|---|---|
| `/api/agent` | Chain, addresses, EIP-712 schema, every funding constraint and its revert |
| `/llms.txt` | The same content as prose, generated from the same source |

Both come from `lib/agent-manifest.ts`, and are advertised in a `Link` header on every
response plus `/.well-known/agent-manifest`, so an agent finds them without parsing HTML.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
```

## Connecting it to a deployment

Nothing is required. The live X Layer testnet deployment is baked in, so `npm run dev` works
with no configuration.

To point the same build elsewhere, copy `.env.example` to `.env.local` and fill in what you
need, or open the app and use the Settings button in the header. Settings are stored in the
browser, so one build serves a local chain, testnet or mainnet.

If you change the addresses, set `NEXT_PUBLIC_DEPLOY_BLOCK` too. Event scans start there, and
scanning from block 0 on a chain past 37 million blocks is rejected by most public RPCs.

Until addresses are set the app runs on clearly labelled sample data rather than showing an
empty shell.

## Deploying to Vercel

**Set the Root Directory to `web`.** Settings, General, Root Directory.

This is the one thing that will bite you. The repository root is the contracts package: its
`package.json` has `"build": "forge build"` and no Next.js in it. Vercel builds the repo root
by default, so it either reports that no Next.js version was detected, or tries to run
`forge build` and fails because Foundry is not installed on the build image. Neither error
mentions directories, which is what makes it annoying to diagnose.

Everything else is zero-config. No environment variable is required, because the live X Layer
testnet deployment is compiled in. Set `NEXT_PUBLIC_SITE_URL` once you have a custom domain so
`robots.txt` and `sitemap.xml` emit absolute URLs against it rather than the `.vercel.app`
hostname.

Verify locally before pushing. It is the same build:

```bash
npm run build
```

## Design notes

- Technical detail is hidden by default. Contract addresses live behind Settings, and
  hashes, model commits and feature hashes live behind "Show technical details" on each
  loan. A lender never has to look at a hash.
- Numbers are explained in words. The leaderboard shows "Excellent" or "Poor" next to the
  raw Brier score, and always shows the sample count, because one good call is not a track
  record.
- `tsconfig.json` targets ES2020. Token amounts are BigInt and the template default of ES6
  rejects BigInt literals.
