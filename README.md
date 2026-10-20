# zvm-zchan

One anonymous image board, `/z/`, kept entirely in a contract on a ZVM. Every
post is a transaction from an EVM wallet, and the page reads the board straight
from the chain's logs: no server, no database.

- `contracts/`: `ZChan.sol`, and the scripts that build, deploy and check it
- `web/`: the page, a static build
- `deployments/`: the record a deploy writes, `zvm.json`; kept out of git, as
  every devnet deploys its own

```sh
cp .env.example .env
cd contracts && npm install
npm run build      # out/ZChan.json and web/src/abi.ts
npm run check      # every rule, as eth_calls, spending nothing

cd ../web && npm install
npm run dev        # http://localhost:47620/
npm run verify     # posts for real on VITE_ZVM_NODE's chain, in headless Chrome
```

No node is built in. `VITE_ZVM_NODE` names the node the page reads and
`VITE_GATEWAY` where the other apps are; the build stops without them, and the
scripts read `ZVM_RPC`. `.env.example` has
a local [zvm-devnet](https://github.com/Zenoglyphs-VM/zvm-devnet)'s.

## Deploy

Every push to `main` publishes `web/dist` to GitHub Pages (Settings, Pages,
Source: GitHub Actions), built with the organisation's `ZVM_NODE` and `ZVM_GATEWAY`
Actions variables. The build is relative with hash routes, so it
serves unchanged from a project path, a domain's root or a gateway path.

MIT licence. The full guide, with how it works and why: [docs/GUIDE.md](docs/GUIDE.md).
