# bluetooth_blockchain

Bittensor (TAO) transfers that are signed with no internet and submitted later by a gateway.
Used by the BLE mesh in `~/Desktop/Code/ble-tao-relay`: the signed bytes hop phone to phone over Bluetooth.

```js
import * as tao from 'bluetooth_blockchain';

const chainState = await tao.fetchChainState(senderAddress);   // online, ~120 B of JSON
const bytes = await tao.buildSignedTransfer({ mnemonic, dest, amountRao, chainState }); // offline, ~145 B
const receipt = await tao.submit(bytes);                        // gateway: { txHash, status, error? }
tao.txHash(bytes);                                              // anyone: match receipts
await tao.close();                                              // drop the RPC socket
```

- Network: Bittensor testnet (`TAO_RPC_URL` overrides). Never use a mainnet key with funds.
- `npm test`: offline tests. `npm run test:online`: adds a live testnet submit.
- Status and decisions: `JOURNAL.md`. Jobs only a human can do: `human_needed_tasks.md`.
