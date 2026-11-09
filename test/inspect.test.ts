import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectDevice } from '../src/device/inspect';
import type { InspectionItem } from '../src/device/inspect';

function tlv(tag: number[], data: number[]): number[] {
  return [...tag, 0x82, data.length >> 8, data.length & 255, ...data];
}

test('read-only discovery decodes firmware BER objects, metadata and existing public keys', async () => {
  const commands: Uint8Array[] = [];
  const rows: InspectionItem[] = [];
  const point = [4, ...new Array<number>(64).fill(1)];
  const attributes = tlv([0x6e], tlv([0x73], [
    ...tlv([0xc1], [0x13, 0x2b, 0x81, 4, 0, 0x0a]),
    ...tlv([0xc3], [0x16, 0x2b, 6, 1, 4, 1, 0xda, 0x47, 0x0f, 1]),
  ]));
  const ok = (data: number[] = []) => Uint8Array.from([...data, 0x90, 0]);
  await inspectDevice({ exchange: async (command) => {
    commands.push(command.slice());
    switch (command[1]) {
      case 0xa4: return ok();
      case 0x31: return command[2] === 0 ? ok() : ok([...new TextEncoder().encode('<untrusted>')]);
      case 0xca: return ok(attributes);
      case 0x47:
        assert.equal(command[2], 0x81, 'only read-public-key P1 is allowed');
        return ok(tlv([0x7f, 0x49], tlv([0x86], point)));
      case 0xf7:
        return command[3] === 0x9c ? ok([
          ...tlv([1], [0x53]), ...tlv([2], [3, 2]), ...tlv([3], [1]),
          ...tlv([4], tlv([0x86], point)),
        ]) : Uint8Array.of(0x6a, 0x88);
      default: throw new Error('Unexpected command');
    }
  } }, (row) => rows.push(row));
  assert.equal(commands.length, 14);
  assert.match(rows.find((row) => row.label.includes('固件'))!.value, /未知/);
  assert.equal(rows.find((row) => row.label === '硬件型号')!.value, '<untrusted>');
  assert.equal(rows.find((row) => row.label === 'OpenPGP SIG 算法')!.value, 'ECDSA / secp256k1');
  assert.equal(rows.find((row) => row.label === 'OpenPGP AUT 算法')!.value, 'EdDSA / Ed25519');
  assert.match(rows.find((row) => row.label === 'PIV 9C 算法')!.value, /待核验/);
  assert.match(rows.at(-1)!.value, /待专用测试设备/);
  assert.ok(commands.every((command) => [0xa4, 0x31, 0xca, 0x47, 0xf7].includes(command[1]!)));
});

test('missing applets and empty version responses never advertise usable signing', async () => {
  const rows: InspectionItem[] = [];
  await inspectDevice({ exchange: async () => Uint8Array.of(0x6a, 0x82) }, (row) => rows.push(row));
  assert.equal(rows.length, 4);
  assert.match(rows.at(-1)!.value, /待专用测试设备/);
});

test('duplicate algorithm metadata fails discovery without accepting ambiguous fields', async () => {
  let applet = '';
  await assert.rejects(inspectDevice({ exchange: async (command) => {
    if (command[1] === 0xa4) {
      applet = command[5] === 0xa0 ? 'piv' : 'other';
      return applet === 'piv' ? Uint8Array.of(0x90, 0) : Uint8Array.of(0x6a, 0x82);
    }
    return Uint8Array.of(1, 1, 0x53, 1, 1, 0xe0, 0x90, 0);
  } }, () => undefined), /Duplicate/);
});

test('OpenPGP-only page can read Admin without sending legacy OpenPGP or PIV probes', async () => {
  const commands: Uint8Array[] = [];
  await inspectDevice({ exchange: async (command) => {
    commands.push(command.slice());
    return Uint8Array.of(0x90, 0);
  } }, () => undefined, { includeOpenPgp: false, includePiv: false });
  assert.equal(commands.length, 3);
  assert.deepEqual(Array.from(commands[0]!.slice(5)), [0xf0, 0, 0, 0, 0]);
  assert.ok(commands.slice(1).every((command) => command[1] === 0x31));
});
