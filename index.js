// TAO transfers for the BLE mesh: fetch chain state while online, sign
// offline, submit from the gateway. Contract: ~/Desktop/Code/ble-tao-relay/INTERFACE.md
//
// The signed transfer is SCALE-encoded by hand, so signing needs only the
// ~50 B chainState (no 400 KB runtime metadata on the phone). The layout is
// pinned to the live runtime: fetchChainState() checks the call index and the
// transaction extensions and throws if a runtime upgrade changed them.
// test/tao.test.js decodes our bytes with polkadot.js + real metadata.
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Keyring } from '@polkadot/keyring';
import { compactAddLength, compactToU8a, hexToU8a, isHex, u8aConcat } from '@polkadot/util';
import { blake2AsHex, blake2AsU8a, cryptoWaitReady, decodeAddress } from '@polkadot/util-crypto';

const RPC_URL = process.env.TAO_RPC_URL ?? 'wss://test.finney.opentensor.ai:443';
const SS58_FORMAT = 42; // Bittensor (testnet and mainnet)
const SUBMIT_TIMEOUT_MS = Number(process.env.TAO_SUBMIT_TIMEOUT_MS ?? 60_000);

// balances.transferKeepAlive: the chain rejects a transfer that would drop the
// sender below the existential deposit instead of silently reaping it.
const TRANSFER_KEEP_ALIVE = Uint8Array.of(0x05, 0x03);

// Order and data checked live on testnet spec 484 (2026-10-24). Only
// CheckMortality (era), CheckNonce, ChargeTransactionPayment (tip) and
// CheckMetadataHash (mode) put bytes in the extrinsic; CheckSpecVersion,
// CheckTxVersion, CheckGenesis, CheckMortality (block hash) and
// CheckMetadataHash (Option hash) add implicit bytes to the signed payload.
export const EXPECTED_EXTENSIONS = [
  'CheckNonZeroSender', 'CheckSpecVersion', 'CheckTxVersion', 'CheckGenesis', 'CheckMortality',
  'CheckNonce', 'CheckWeight', 'ChargeTransactionPayment', 'SudoTransactionExtension',
  'CheckShieldedTxValidity', 'SubtensorTransactionExtension', 'DrandPriority', 'CheckMetadataHash',
];

const SIGNED_V4 = 0x84;
const MULTI_ADDRESS_ID = 0x00;
const MULTI_SIGNATURE_SR25519 = 0x01;
const IMMORTAL_ERA = 0x00;
const METADATA_HASH_DISABLED = 0x00;
const NONE = 0x00;

let apiPromise = null;

function getApi() {
  apiPromise ??= ApiPromise.create({ provider: new WsProvider(RPC_URL), noInitWarn: true });
  return apiPromise;
}

// Closes the shared RPC connection so the process can exit.
export async function close() {
  if (!apiPromise) return;
  const api = await apiPromise;
  apiPromise = null;
  await api.disconnect();
}

// Throws if the live runtime no longer matches the hand-encoded layout.
function assertRuntimeMatches(api) {
  const callIndex = api.tx.balances.transferKeepAlive.callIndex;
  if (callIndex[0] !== TRANSFER_KEEP_ALIVE[0] || callIndex[1] !== TRANSFER_KEEP_ALIVE[1]) {
    throw new Error(`runtime changed: balances.transferKeepAlive is now 0x${Buffer.from(callIndex).toString('hex')}; update tao/index.js`);
  }
  const live = api.registry.signedExtensions.join(',');
  if (live !== EXPECTED_EXTENSIONS.join(',')) {
    throw new Error(`runtime changed: transaction extensions are now [${live}]; update tao/index.js`);
  }
}

export async function fetchChainState(ss58Address) {
  decodeAddress(ss58Address); // throws on a malformed address
  const api = await getApi();
  assertRuntimeMatches(api);
  const nonce = await api.rpc.system.accountNextIndex(ss58Address);
  return {
    genesisHash: api.genesisHash.toHex(),
    specVersion: api.runtimeVersion.specVersion.toNumber(),
    transactionVersion: api.runtimeVersion.transactionVersion.toNumber(),
    nonce: nonce.toNumber(),
  };
}

function u32le(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function parseChainState({ genesisHash, specVersion, transactionVersion, nonce } = {}) {
  if (!isHex(genesisHash, 256)) throw new Error('chainState.genesisHash must be a 0x-prefixed 32-byte hex string');
  for (const [name, value] of Object.entries({ specVersion, transactionVersion, nonce })) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`chainState.${name} must be a u32`);
  }
  return { genesis: hexToU8a(genesisHash), specVersion, transactionVersion, nonce };
}

export async function buildSignedTransfer({ mnemonic, dest, amountRao, chainState }) {
  const amount = BigInt(amountRao);
  if (amount <= 0n || amount >= 2n ** 64n) throw new Error('amountRao must be a positive u64');
  const destKey = decodeAddress(dest); // throws on a malformed address
  const { genesis, specVersion, transactionVersion, nonce } = parseChainState(chainState);

  await cryptoWaitReady();
  const pair = new Keyring({ type: 'sr25519', ss58Format: SS58_FORMAT }).addFromMnemonic(mnemonic);

  const call = u8aConcat(TRANSFER_KEEP_ALIVE, [MULTI_ADDRESS_ID], destKey, compactToU8a(amount));
  const extra = u8aConcat([IMMORTAL_ERA], compactToU8a(nonce), compactToU8a(0) /* tip */, [METADATA_HASH_DISABLED]);
  const implicit = u8aConcat(
    u32le(specVersion),
    u32le(transactionVersion),
    genesis,
    genesis, // an immortal era signs against the genesis block
    [NONE], // no metadata hash
  );

  // Substrate signs the blake2-256 of payloads longer than 256 bytes.
  const payload = u8aConcat(call, extra, implicit);
  const signature = pair.sign(payload.length > 256 ? blake2AsU8a(payload, 256) : payload);

  return compactAddLength(
    u8aConcat([SIGNED_V4, MULTI_ADDRESS_ID], pair.publicKey, [MULTI_SIGNATURE_SR25519], signature, extra, call),
  );
}

export function txHash(signedBytes) {
  return blake2AsHex(signedBytes, 256);
}

// Resolves once the tx is in a block or rejected. If no block includes it
// within the timeout it is still in the pool: status 'submitted'. The mesh can
// deliver the same tx twice, so "already imported" also counts as submitted.
export async function submit(signedBytes) {
  const hash = txHash(signedBytes);
  const api = await getApi();

  return new Promise((resolve) => {
    let unsubscribe = null;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve({ txHash: hash, ...result });
    };
    const timer = setTimeout(() => finish({ status: 'submitted' }), SUBMIT_TIMEOUT_MS);

    let extrinsic;
    try {
      extrinsic = api.createType('Extrinsic', signedBytes);
    } catch (err) {
      finish({ status: 'error', error: `undecodable transaction: ${err.message}` });
      return;
    }

    api.rpc.author
      .submitAndWatchExtrinsic(extrinsic, async (status) => {
        if (status.isInBlock) {
          finish(await inclusionResult(api, status.asInBlock, hash).catch((err) => ({ status: 'error', error: err.message })));
        } else if (status.isInvalid || status.isDropped || status.isUsurped) {
          finish({ status: 'error', error: `transaction ${status.type.toLowerCase()}` });
        }
      })
      .then((unsub) => (finished ? unsub() : (unsubscribe = unsub)))
      .catch((err) =>
        finish(/already imported/i.test(err.message) ? { status: 'submitted' } : { status: 'error', error: err.message }),
      );
  });
}

// A tx can land in a block and still fail, e.g. when the transfer would break
// the existential deposit. Look up its ExtrinsicFailed event to tell.
async function inclusionResult(api, blockHash, hash) {
  const [{ block }, apiAt] = await Promise.all([api.rpc.chain.getBlock(blockHash), api.at(blockHash)]);
  const index = block.extrinsics.findIndex((ext) => ext.hash.toHex() === hash);
  const events = await apiAt.query.system.events();
  const failed = events.find(
    ({ phase, event }) =>
      phase.isApplyExtrinsic && phase.asApplyExtrinsic.eqn(index) && api.events.system.ExtrinsicFailed.is(event),
  );
  if (!failed) return { status: 'in_block' };

  const [dispatchError] = failed.event.data;
  if (!dispatchError.isModule) return { status: 'error', error: dispatchError.toString() };
  const { section, name } = api.registry.findMetaError(dispatchError.asModule);
  return { status: 'error', error: `${section}.${name}` };
}
