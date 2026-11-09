import { transmit } from './apdu';
import type { ApduCommand, ApduTransport } from './apdu';
import { parseTlv, uniqueTag } from './tlv';

export interface InspectionItem {
  readonly label: string;
  readonly value: string;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function text(bytes: Uint8Array): string {
  if (bytes.length === 0) return '未知（设备未提供）';
  if (!bytes.every((byte) => byte >= 0x20 && byte <= 0x7e)) return `原始数据 0x${hex(bytes)}`;
  return new TextDecoder().decode(bytes);
}

function algorithm(bytes: Uint8Array | undefined): string {
  if (!bytes) return '未返回算法属性';
  const encoding = hex(bytes);
  if (encoding === '132b8104000a') return 'ECDSA / secp256k1';
  if (encoding === '162b06010401da470f01') return 'EdDSA / Ed25519';
  return `其他算法 0x${encoding}`;
}

/** Fixed read-only commands. The UI accepts neither APDUs nor key management input. */
export async function inspectDevice(
  transport: ApduTransport,
  report: (item: InspectionItem) => void,
  options: { readonly includePiv?: boolean; readonly includeOpenPgp?: boolean } = {},
): Promise<void> {
  async function read(label: string, command: ApduCommand): Promise<Uint8Array | undefined> {
    const response = await transmit(transport, command);
    if (response.status !== 0x9000) {
      report({ label, value: `读取未成功 SW=${response.status.toString(16).padStart(4, '0')}` });
      return undefined;
    }
    return response.data;
  }

  async function select(label: string, aid: number[]): Promise<boolean> {
    return await read(label, { cla: 0, ins: 0xa4, p1: 4, p2: 0, data: Uint8Array.from(aid) }) !== undefined;
  }

  if (await select('Admin applet', [0xf0, 0, 0, 0, 0])) {
    const version = await read('固件版本', { cla: 0, ins: 0x31, p1: 0, p2: 0, le: 256 });
    if (version) report({ label: '固件版本（Admin 原始报告）', value: text(version) });
    const hardware = await read('硬件型号', { cla: 0, ins: 0x31, p1: 1, p2: 0, le: 256 });
    if (hardware) report({ label: '硬件型号', value: text(hardware) });
  }

  if (options.includeOpenPgp !== false && await select('OpenPGP applet', [0xd2, 0x76, 0, 1, 0x24, 1])) {
    const application = await read('OpenPGP 应用属性', { cla: 0, ins: 0xca, p1: 0, p2: 0x6e, le: 256 });
    if (application) {
      const outer = parseTlv(application);
      const root = uniqueTag(outer, 0x6e);
      const objects = root ? parseTlv(root) : outer;
      const discretionary = uniqueTag(objects, 0x73);
      if (!discretionary) throw new Error('OpenPGP 缺少 73 属性容器');
      const attributes = parseTlv(discretionary);
      report({ label: 'OpenPGP SIG 算法', value: algorithm(uniqueTag(attributes, 0xc1)) });
      report({ label: 'OpenPGP AUT 算法', value: algorithm(uniqueTag(attributes, 0xc3)) });
    }
    for (const [name, reference] of [['SIG', 0xb6], ['AUT', 0xa4]] as const) {
      const key = await read(`OpenPGP ${name} 公钥`, {
        cla: 0, ins: 0x47, p1: 0x81, p2: 0, data: Uint8Array.of(reference, 0), le: 256,
      });
      if (key) {
        const template = uniqueTag(parseTlv(key), 0x7f49);
        if (!template) throw new Error('OpenPGP 缺少公钥模板');
        const point = uniqueTag(parseTlv(template), 0x86);
        report({ label: `OpenPGP ${name} 公钥`, value: point ? hex(point) : `其他公钥模板 0x${hex(template)}` });
      }
    }
  }

  if (options.includePiv !== false && await select('PIV applet', [0xa0, 0, 0, 3, 8])) {
    for (const slot of [0x9a, 0x9c, 0x9d, 0x9e, 0x82, 0x83]) {
      const name = `PIV ${slot.toString(16).toUpperCase()}`;
      const metadata = await read(`${name} metadata`, { cla: 0, ins: 0xf7, p1: 0, p2: slot, le: 256 });
      if (!metadata) continue;
      const items = parseTlv(metadata);
      const id = uniqueTag(items, 1);
      if (!id || id.length !== 1) throw new Error('PIV metadata 算法字段无效');
      const assumed = id[0] === 0x53 ? '默认映射 secp256k1（待核验）'
        : id[0] === 0xe0 ? '默认映射 Ed25519（待核验）' : '其他算法';
      report({ label: `${name} 算法`, value: `0x${hex(id)} · ${assumed}` });
      const policy = uniqueTag(items, 2);
      report({ label: `${name} PIN / 触摸策略原始值`, value: policy ? hex(policy) : '未知' });
      const key = uniqueTag(items, 4);
      const point = key ? uniqueTag(parseTlv(key), 0x86) : undefined;
      report({ label: `${name} 公钥`, value: point ? hex(point) : '未提供 ECC 公钥' });
    }
  }
  report({ label: '签名能力', value: '待专用测试设备完成 PIN、触摸、签名和独立验签' });
}
