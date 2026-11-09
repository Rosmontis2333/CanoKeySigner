/** CanoKey core 3.0.3 WebUSB accepts at most 1340 command bytes. */
export const MAX_COMMAND_BYTES = 1340;
export const MAX_RESPONSE_BYTES = 1342;

export interface ApduCommand {
  readonly cla: number;
  readonly ins: number;
  readonly p1: number;
  readonly p2: number;
  readonly data?: Uint8Array;
  readonly le?: number;
}

export interface ApduResponse {
  readonly data: Uint8Array;
  readonly status: number;
}

export function encodeCommand(command: ApduCommand): Uint8Array<ArrayBuffer> {
  const header = [command.cla, command.ins, command.p1, command.p2];
  if (header.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('APDU header must contain four bytes');
  }
  const data = command.data ?? new Uint8Array();
  if (data.length > MAX_COMMAND_BYTES - 5) throw new Error('APDU data exceeds the 3.0.3 command limit');
  const le = command.le;
  if (le !== undefined && (!Number.isInteger(le) || le < 1 || le > 65536)) {
    throw new Error('Invalid APDU response length');
  }
  const extended = data.length > 255 || (le !== undefined && le > 256);
  const bytes = [...header];
  if (data.length > 0) {
    if (extended) bytes.push(0, data.length >> 8, data.length & 255);
    else bytes.push(data.length);
    bytes.push(...data);
  }
  if (le !== undefined) {
    if (extended) {
      if (data.length === 0) bytes.push(0);
      bytes.push((le >> 8) & 255, le & 255);
    } else bytes.push(le & 255);
  }
  if (bytes.length > MAX_COMMAND_BYTES) throw new Error('APDU exceeds the 3.0.3 WebUSB command limit');
  return Uint8Array.from(bytes);
}

export function decodeResponse(bytes: Uint8Array): ApduResponse {
  if (bytes.length < 2 || bytes.length > MAX_RESPONSE_BYTES) throw new Error('Invalid APDU response length');
  return {
    data: bytes.slice(0, -2),
    status: (bytes[bytes.length - 2]! << 8) | bytes[bytes.length - 1]!,
  };
}

export interface ApduTransport {
  exchange(command: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
}

/** Bounded GET RESPONSE handling. No automatic command retries. */
export async function transmit(transport: ApduTransport, command: ApduCommand): Promise<ApduResponse> {
  async function send(command: ApduCommand): Promise<ApduResponse> {
    const bytes = encodeCommand(command);
    try {
      return decodeResponse(await transport.exchange(bytes));
    } finally {
      bytes.fill(0);
    }
  }
  let response = await send(command);
  let data = response.data;
  let rounds = 0;
  while ((response.status >> 8) === 0x61) {
    if (++rounds > 16) throw new Error('Too many GET RESPONSE continuations');
    response = await send({
      cla: 0, ins: 0xc0, p1: 0, p2: 0, le: (response.status & 255) || 256,
    });
    if (data.length + response.data.length > MAX_RESPONSE_BYTES - 2) {
      throw new Error('APDU response exceeds the 3.0.3 buffer limit');
    }
    const combined = new Uint8Array(data.length + response.data.length);
    combined.set(data);
    combined.set(response.data, data.length);
    data = combined;
  }
  return { data, status: response.status };
}
