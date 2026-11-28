'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { decodeTakerEvent } = require('../tensor-scanner');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(buffer) {
  let n = BigInt('0x' + buffer.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < buffer.length && buffer[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + out;
}
function key(byte) { return Buffer.alloc(32, byte); }
function optionKey(value) {
  return value ? Buffer.concat([Buffer.from([1]), value]) : Buffer.from([0]);
}
function makeTakerEvent() {
  const discriminator = crypto.createHash('sha256').update('global:tcomp_noop').digest().subarray(0, 8);
  const amount = Buffer.alloc(8); amount.writeBigUInt64LE(2_500_000_000n);
  const quantity = Buffer.alloc(4); quantity.writeUInt32LE(1);
  const fee = Buffer.alloc(8);
  const creatorFee = Buffer.alloc(8); creatorFee.writeBigUInt64LE(50_000_000n);
  const bytes = Buffer.concat([
    discriminator,
    Buffer.from([1]), // TcompEvent::Taker
    key(1), // taker
    optionKey(null), // bid_id
    Buffer.from([0]), // Target::AssetId
    key(2), // target_id
    Buffer.from([0]), // field: None
    optionKey(null), // field_id
    amount, quantity, fee, fee, fee, creatorFee,
    optionKey(null), // native SOL
    optionKey(key(3)) // asset_id
  ]);
  return { bytes, mint: encodeBase58(key(3)), taker: encodeBase58(key(1)) };
}

test('decodes a valid Tensor Taker event and lamport amounts', () => {
  const fixture = makeTakerEvent();
  const event = decodeTakerEvent(encodeBase58(fixture.bytes));
  assert.equal(event.taker, fixture.taker);
  assert.equal(event.assetId, fixture.mint);
  assert.equal(event.amountLamports, '2500000000');
  assert.equal(event.creatorFeeLamports, '50000000');
  assert.equal(event.quantity, 1);
  assert.equal(event.currency, null);
});

test('ignores Maker events and unrelated instruction data', () => {
  const fixture = makeTakerEvent();
  fixture.bytes[8] = 0;
  assert.equal(decodeTakerEvent(encodeBase58(fixture.bytes)), null);
  assert.equal(decodeTakerEvent(encodeBase58(Buffer.from('not a tensor event'))), null);
});

test('rejects truncated Taker payloads instead of fabricating fields', () => {
  const fixture = makeTakerEvent();
  const discriminator = fixture.bytes.subarray(0, 8);
  const truncated = Buffer.concat([discriminator, Buffer.from([1, 0])]);
  assert.throws(() => decodeTakerEvent(encodeBase58(truncated)));
});
