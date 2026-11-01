# Journal: bluetooth_blockchain (TAO transactions)

## Current goal
Offline phone signs a TAO transfer → hops over BLE → gateway submits to Bittensor testnet → receipt hops back.
Standalone package, split out of ~/Desktop/Code/ble-tao-relay on 2026-10-24. The Bluetooth side (session `AI_Bluetooth`) stays there; contract: ble-tao-relay/INTERFACE.md.

## Status (TAO side)
- [x] `index.js`: fetchChainState, buildSignedTransfer (immortal era), submit, txHash, plus close().
- [x] `test/tao.test.js`: 5 offline tests + 1 live test (`TAO_ONLINE=1`). All pass: `npm test` (offline), `npm run test:online` (live).
- [x] Live check 2026-10-24: unfunded tx is refused by testnet with "Inability to pay some fees".
- [ ] Real transfer into a block: waits on testnet TAO (./human_needed_tasks.md).

## Next steps
- Once the user funds a testnet address: send a real transfer, check `status: 'in_block'`.
- When AI_Bluetooth's `mesh/` is ready: wire TAO_TX (0x10) → `submit` → TAO_RECEIPT (0x11) on the gateway.

## Key decisions
- Hand-encoded SCALE instead of polkadot.js + metadata: the sender needs only the ~50 B chainState, not 416 KB of metadata. That makes "get chainState from the gateway over BLE" work.
- Guard: fetchChainState throws if the live call index (0x0503) or extension list changes (a runtime upgrade).
- Tests decode our bytes with polkadot.js + real metadata (`fixtures/testnet-metadata-484.scale.gz`) and verify the signature against polkadot.js's payload.
- transferKeepAlive (not allowDeath): the sender can't reap their own account by accident.
- submit treats "already imported" as submitted, because the mesh can deliver the same tx twice.

## Gotchas
- Testnet: wss://test.finney.opentensor.ai:443, spec 484, txVersion 1, ss58 42, 9 decimals, Balance is u64.
- `ext.version` in polkadot.js includes the signed bit (0x84 = 132).
- MultiAddress decoded via polkadot.js has no `.asId` here; use `.toString()`.
- The fork's metadata-based draft is at ~/.claude/worktrees/tao-signing/... (not used).

- ble-tao-relay uses this package as a file dependency: `"bluetooth_blockchain": "file:../../All_Projects/bluetooth_blockchain"`, so `import * as tao from 'bluetooth_blockchain'`. Moving this folder breaks that link.
