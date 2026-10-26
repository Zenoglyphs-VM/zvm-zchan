# Isolated contract behavior

From the repository root, with Node 22 or later:

```sh
npm ci --ignore-scripts --prefix contracts/test
npm --prefix contracts run test:isolated
```

The separately locked toolchain freshly compiles the current `ZChan.sol` with
solc 0.8.19, Paris and optimizer 200. The complete saved creation/runtime
artifact, its source/settings input and the frontend ABI must match. Missing
dependencies and compiler errors fail; saved application bytecode is not used
to run the fixture.

Contract state is created by actual constructors and function calls in an
empty EthereumJS Paris EVM. There are no contract storage overrides. The suite
checks thread/reply rules and byte limits, exact events and poster IDs,
case-insensitive handles and fee accounting, author deletion, janitor
removal/restoration, ownership transfer/renunciation and withdrawal failure
and recovery. Seeded real-call histories are checked against an independent
business model and a separate decoded-log replay, including native balances.
The only counterpart stub is a controlled payment recipient.

Addresses, balances and block context are synthetic. No RPC, browser, wallet,
private key, signature or real funds are used. These message frames do not
qualify canonical transactions, intrinsic gas or fees, ZVM behavior, chain
payload limits, browser reorg/index recovery or image rendering. Poster IDs
are a display convention; transaction senders remain public on a real chain.
The replay model is independent of the page and does not qualify its scanner.

The original `npm run check` remains a separate deployed-contract check with
an explicitly selected RPC/deployment record and state overrides. CI runs
the isolated suite, independently executes the real build, and rejects
changes in the tracked artifact or ABI.
