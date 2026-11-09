export interface Tlv {
  readonly tag: number;
  readonly value: Uint8Array;
}

/** Bounded BER-TLV used by the public data objects in CanoKey 3.0.3. */
export function parseTlv(bytes: Uint8Array): readonly Tlv[] {
  if (bytes.length > 1340) throw new Error('TLV exceeds the device buffer');
  const result: Tlv[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let tag = bytes[offset++]!;
    if ((tag & 0x1f) === 0x1f) {
      let count = 0;
      let byte: number;
      do {
        if (offset >= bytes.length || ++count > 2) throw new Error('Invalid TLV tag');
        byte = bytes[offset++]!;
        if (count === 1 && (byte & 0x7f) === 0) throw new Error('Non-canonical TLV tag');
        tag = tag * 256 + byte;
      } while (byte & 0x80);
    }
    if (offset >= bytes.length) throw new Error('Missing TLV length');
    let length = bytes[offset++]!;
    if (length & 0x80) {
      const size = length & 0x7f;
      if (size < 1 || size > 2 || offset + size > bytes.length) throw new Error('Invalid TLV length');
      length = 0;
      for (let i = 0; i < size; i++) length = length * 256 + bytes[offset++]!;
      // OpenPGP 3.0.3 deliberately uses 0x82 lengths for short public keys.
    }
    if (offset + length > bytes.length) throw new Error('Truncated TLV');
    result.push({ tag, value: bytes.slice(offset, offset + length) });
    offset += length;
  }
  return result;
}

export function uniqueTag(items: readonly Tlv[], tag: number): Uint8Array | undefined {
  const matches = items.filter((item) => item.tag === tag);
  if (matches.length > 1) throw new Error('Duplicate TLV field');
  return matches[0]?.value;
}
