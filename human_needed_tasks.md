# Human-needed tasks (TAO)

Tasks Claude can't do (accounts, payments, devices).

## [ ] Get testnet TAO for a real end-to-end transfer (~10 min + wait)

Needed only for a transfer that actually lands in a block. Signing, hashing and the "rejected: can't pay fees" path already work and are tested.

1. Make a throwaway testnet wallet (never a mainnet key with funds): `node -e "import('@polkadot/util-crypto').then(async u=>{await u.cryptoWaitReady();const m=u.mnemonicGenerate();const {Keyring}=await import('@polkadot/keyring');console.log(m);console.log(new Keyring({type:'sr25519',ss58Format:42}).addFromMnemonic(m).address)})"`
2. Save the 12 words somewhere private. Post only the `5…` address.
3. There's no public faucet. Ask in the Bittensor Discord channel "Requests for Testnet TAO" (see https://docs.learnbittensor.org/bittensor-networks). 1 testTAO is plenty.
4. Tell the TAO session (`bluetooth_blockchain`) the address once funded.
