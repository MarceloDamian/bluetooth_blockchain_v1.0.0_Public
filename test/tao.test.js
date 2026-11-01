// Offline: decode our hand-encoded transfer with polkadot.js and the real
// testnet metadata (fixtures/), and verify the signature against the
// payload polkadot.js itself would sign.
// Online (TAO_ONLINE=1): fetch live chain state and submit an unfunded tx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Keyring } from '@polkadot/keyring';
import { Metadata, TypeRegistry } from '@polkadot/types';
import { cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';
import { EXPECTED_EXTENSIONS, buildSignedTransfer, close, fetchChainState, submit, txHash } from '../index.js';

// Public dev phrase: a throwaway key, never fund it with anything real.
const MNEMONIC = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
const DEST = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const CHAIN_STATE = {
  genesisHash: '0x8f9cf856bf558a14440e75569c9e58594757048d7b3a84b5d25f6bd978263105', // testnet
  specVersion: 484,
  transactionVersion: 1,
  nonce: 7,
};

const NULL_EXTENSIONS = Object.fromEntries(
  ['SudoTransactionExtension', 'CheckShieldedTxValidity', 'SubtensorTransactionExtension', 'DrandPriority'].map(
    (name) => [name, { extrinsic: {}, payload: {} }],
  ),
);

function testnetRegistry() {
  const registry = new TypeRegistry();
  const metadata = new Metadata(registry, gunzipSync(readFileSync(new URL('../fixtures/testnet-metadata-484.scale.gz', import.meta.url))));
  registry.setMetadata(metadata, undefined, NULL_EXTENSIONS);
  return registry;
}

async function sender() {
  await cryptoWaitReady();
  return new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(MNEMONIC);
}

test('fixture metadata has the extensions the encoder assumes', () => {
  assert.deepEqual(testnetRegistry().signedExtensions, EXPECTED_EXTENSIONS);
});

test('polkadot.js decodes the transfer with the right fields', async () => {
  const bytes = await buildSignedTransfer({ mnemonic: MNEMONIC, dest: DEST, amountRao: 123_456_789n, chainState: CHAIN_STATE });
  const registry = testnetRegistry();
  const ext = registry.createType('Extrinsic', bytes);

  assert.equal(ext.isSigned, true);
  assert.equal(ext.version & 0x7f, 4); // high bit = signed
  assert.equal(`${ext.method.section}.${ext.method.method}`, 'balances.transferKeepAlive');
  assert.equal(ext.method.args[0].toString(), DEST);
  assert.equal(ext.method.args[1].toBigInt(), 123_456_789n);
  assert.equal(ext.era.isImmortalEra, true);
  assert.equal(ext.nonce.toNumber(), 7);
  assert.equal(ext.tip.toBigInt(), 0n);
  assert.equal(ext.signer.toString(), registry.createType('AccountId', (await sender()).address).toString());
  assert.deepEqual(ext.toU8a(), bytes, 're-encoding is byte-identical');
});

test('signature verifies against the payload polkadot.js builds', async () => {
  const bytes = await buildSignedTransfer({ mnemonic: MNEMONIC, dest: DEST, amountRao: 5n, chainState: CHAIN_STATE });
  const registry = testnetRegistry();
  const ext = registry.createType('Extrinsic', bytes);
  const payload = registry.createType('ExtrinsicPayload', {
    method: ext.method.toHex(),
    era: ext.era,
    nonce: CHAIN_STATE.nonce,
    tip: 0,
    mode: 0,
    specVersion: CHAIN_STATE.specVersion,
    transactionVersion: CHAIN_STATE.transactionVersion,
    genesisHash: CHAIN_STATE.genesisHash,
    blockHash: CHAIN_STATE.genesisHash,
    version: 4,
  });
  const { isValid } = signatureVerify(payload.toU8a({ method: true }), ext.signature.toU8a(), (await sender()).address);
  assert.equal(isValid, true);

  const wrongNonce = registry.createType('ExtrinsicPayload', { ...payload.toJSON(), nonce: 8, version: 4 });
  assert.equal(signatureVerify(wrongNonce.toU8a({ method: true }), ext.signature.toU8a(), (await sender()).address).isValid, false);
});

test('txHash is the 0x blake2-256 polkadot.js reports, and the tx fits a BLE payload', async () => {
  const bytes = await buildSignedTransfer({ mnemonic: MNEMONIC, dest: DEST, amountRao: 10n ** 9n, chainState: CHAIN_STATE });
  const hash = txHash(bytes);
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(hash, testnetRegistry().createType('Extrinsic', bytes).hash.toHex());
  assert.ok(bytes.length <= 160, `tx is ${bytes.length} B`);
});

test('rejects bad input', async () => {
  const ok = { mnemonic: MNEMONIC, dest: DEST, amountRao: 1n, chainState: CHAIN_STATE };
  await assert.rejects(buildSignedTransfer({ ...ok, amountRao: 0n }), /positive u64/);
  await assert.rejects(buildSignedTransfer({ ...ok, amountRao: 2n ** 64n }), /positive u64/);
  await assert.rejects(buildSignedTransfer({ ...ok, dest: 'not-an-address' }));
  await assert.rejects(buildSignedTransfer({ ...ok, chainState: { ...CHAIN_STATE, genesisHash: '0x1234' } }), /genesisHash/);
  await assert.rejects(buildSignedTransfer({ ...ok, chainState: { ...CHAIN_STATE, nonce: -1 } }), /nonce/);
  await assert.rejects(buildSignedTransfer({ ...ok, chainState: undefined }), /genesisHash/);
});

test('live testnet: chain state matches and an unfunded tx is rejected cleanly', { skip: !process.env.TAO_ONLINE && 'set TAO_ONLINE=1' }, async (t) => {
  t.after(close);
  const pair = await sender();
  const state = await fetchChainState(pair.address);
  assert.equal(state.genesisHash, CHAIN_STATE.genesisHash);
  assert.ok(Number.isInteger(state.nonce));

  // Uses a fresh random key so it can never be funded: the pool must refuse it.
  const { mnemonicGenerate } = await import('@polkadot/util-crypto');
  const mnemonic = mnemonicGenerate();
  const fresh = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromMnemonic(mnemonic);
  const bytes = await buildSignedTransfer({ mnemonic, dest: DEST, amountRao: 1_000n, chainState: await fetchChainState(fresh.address) });
  const receipt = await submit(bytes);
  assert.equal(receipt.txHash, txHash(bytes));
  assert.equal(receipt.status, 'error');
  assert.match(receipt.error, /pay|balance|fund/i);
});
