import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeResponse, encodeCommand, transmit } from '../src/device/apdu';
import { parseTlv, uniqueTag } from '../src/device/tlv';

const header = { cla: 0, ins: 0x47, p1: 0x81, p2: 0 };

test('short and extended APDU cases encode 255/256 and Le boundaries', () => {
  assert.deepEqual(encodeCommand(header), Uint8Array.of(0, 0x47, 0x81, 0));
  assert.deepEqual(encodeCommand({ ...header, le: 256 }), Uint8Array.of(0, 0x47, 0x81, 0, 0));
  assert.deepEqual(encodeCommand({ ...header, le: 65536 }), Uint8Array.of(0, 0x47, 0x81, 0, 0, 0, 0));
  const short = encodeCommand({ ...header, data: new Uint8Array(255), le: 256 });
  assert.equal(short.length, 261);
  assert.equal(short[4], 255);
  const extended = encodeCommand({ ...header, data: new Uint8Array(256), le: 256 });
  assert.equal(extended.length, 265);
  assert.deepEqual(extended.slice(4, 7), Uint8Array.of(0, 1, 0));
  assert.deepEqual(extended.slice(-2), Uint8Array.of(1, 0));
});

test('1340-byte command limit includes the header and extended lengths', () => {
  assert.equal(encodeCommand({ ...header, data: new Uint8Array(1333) }).length, 1340);
  assert.equal(encodeCommand({ ...header, data: new Uint8Array(1331), le: 64 }).length, 1340);
  assert.throws(() => encodeCommand({ ...header, data: new Uint8Array(1334) }));
  assert.throws(() => encodeCommand({ ...header, data: new Uint8Array(1332), le: 64 }));
  assert.throws(() => encodeCommand({ ...header, data: new Uint8Array(1_000_000) }));
  for (const value of [-1, 0, 65537, 1.5, NaN]) assert.throws(() => encodeCommand({ ...header, le: value }));
  assert.throws(() => encodeCommand({ ...header, ins: 256 }));
  assert.throws(() => decodeResponse(Uint8Array.of(0x90)));
  assert.throws(() => decodeResponse(new Uint8Array(1343)));
});

test('GET RESPONSE concatenates exact bytes and never retries error statuses', async () => {
  const commands: Uint8Array[] = [];
  const replies = [Uint8Array.of(1, 2, 0x61, 0), Uint8Array.of(3, 4, 0x90, 0)];
  const response = await transmit({ exchange: async (command) => {
    commands.push(command.slice());
    return replies.shift()!;
  } }, header);
  assert.deepEqual(response.data, Uint8Array.of(1, 2, 3, 4));
  assert.equal(response.status, 0x9000);
  assert.deepEqual(commands[1], Uint8Array.of(0, 0xc0, 0, 0, 0));
  let count = 0;
  const failed = await transmit({ exchange: async () => { count++; return Uint8Array.of(0x6c, 0x20); } }, header);
  assert.equal(failed.status, 0x6c20);
  assert.equal(count, 1);
});

test('GET RESPONSE stops on excessive continuation count and aggregate size', async () => {
  await assert.rejects(transmit({ exchange: async () => Uint8Array.of(0x61, 1) }, header), /continuations/);
  const reply = new Uint8Array(1342);
  reply.set([0x61, 1], 1340);
  await assert.rejects(transmit({ exchange: async () => reply }, header), /buffer limit/);
});

test('BER TLV accepts the actual nonminimal OpenPGP length form and bounds every object', () => {
  const bytes = Uint8Array.of(0x7f, 0x49, 0x82, 0, 4, 0x86, 0x82, 0, 0);
  const template = uniqueTag(parseTlv(bytes), 0x7f49)!;
  assert.equal(uniqueTag(parseTlv(template), 0x86)!.length, 0);
  for (const bad of [[0x86], [0x86, 0x80], [0x86, 0x81], [0x86, 2, 1], [0x7f], [0x7f, 0x80, 0]]) {
    assert.throws(() => parseTlv(Uint8Array.from(bad)));
  }
  assert.throws(() => uniqueTag(parseTlv(Uint8Array.of(1, 0, 1, 0)), 1), /Duplicate/);
  assert.throws(() => parseTlv(new Uint8Array(1341)));
});

test('encoded VERIFY buffers are cleared on both success and transport failure', async () => {
  const command = { cla: 0, ins: 0x20, p1: 0, p2: 0x81, data: Uint8Array.of(1, 2, 3, 4, 5, 6) };
  let captured: Uint8Array | undefined;
  await transmit({ exchange: async (bytes) => {
    captured = bytes;
    assert.equal(bytes[1], 0x20);
    return Uint8Array.of(0x90, 0);
  } }, command);
  assert.ok(captured!.every((byte) => byte === 0));
  await assert.rejects(transmit({ exchange: async (bytes) => {
    captured = bytes;
    throw new Error('disconnected');
  } }, command), /disconnected/);
  assert.ok(captured!.every((byte) => byte === 0));
});
