# Isolated browser qualification

Run `npm ci`, `npm run test:types` and `npm run test:browser` from `web/`.
The runner uses an installed Chrome/Chromium (`CHROME_BIN` can select it).
It refuses a missing browser instead of downloading one. Node 22.12 or newer
is required by the existing Puppeteer dependency.

The test bundles the actual TypeScript browser modules with Vite and exercises
the original production `boot.ts`/`main.ts` entry in an iframe. A bounded,
read-only JSON-RPC model is bound to `127.0.0.1` on an ephemeral port. It never
forwards requests or signs/funds transactions. Only explicit browser source
directories and `index.html` are staged in a fresh temporary directory; real
deployment records, environment files, keys and dependency trees are not copied.
The fixture deployment is synthetic and is never shipped as a release record.

Both HTML entries use the resulting static bundles; no development server,
dependency prebundling cache or hot-reload listener is needed.

The scenarios cover canonical appends, same-height/deep/shorter reorgs, rollback
before deployment, stale timestamps, malformed logs, interrupted pagination,
branch changes during a read, bounded range splitting, concurrent scans,
native blob decoding/revocation, in-flight orphan images, image receipt identity,
literal hostile text, pagination and the production page's polling refresh.
Four seeded histories check 128 append/reorg operations against retained
canonical snapshots. Failures report their scenario and fail the command.

The board now commits a complete candidate view only after log-block and
checkpoint hashes agree. A changed checkpoint triggers a full replay from
deployment, so reorg depth is not limited to two blocks. This uses additional
block-header reads and can require a complete history read after a reorg.
It relies on one RPC endpoint's consistent observations; it is not an
authenticated header chain or finality proof. A node must supply standard
`blockHash` fields for logs and block-by-hash timestamp fallback.

Generic outages fail directly. Only explicit range/result-size refusals split
the range, with at most 128 provider requests per range call and no hidden
request retries. A failed scan preserves the previous accepted view and cursor.
Rebuilds revoke cached blob URLs and reject old queued/in-flight image responses.

These tests do not qualify wallet/provider switching, real keys or funds,
posting, transaction inclusion/fees, image upload metadata stripping or decode
resource limits, accepted ZVM engines, authenticated deployments, RPC honesty,
NoM finality or production readiness. The existing `verify` script remains a
separate real-chain scenario with its own prerequisites.
