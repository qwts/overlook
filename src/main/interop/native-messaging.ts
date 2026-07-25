import type { Readable, Writable } from 'node:stream';

import { INTEROP_CONTROL_FRAME_BYTES, InteropTransportError, assertBoundedControlFrame } from './transport.js';

const HEADER_BYTES = 4;

export interface NativeMessageResponse {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly code?: string;
  readonly retryable?: boolean;
}

function corrupt(message: string): InteropTransportError {
  return new InteropTransportError(message, 'corrupt', false);
}

/** Reads exactly one Chromium native-messaging frame without buffering beyond
 * the ADR-0016 64 KiB control-frame ceiling. */
export async function readNativeMessage(input: Readable): Promise<unknown> {
  const iterator = input[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  const readExactly = async (length: number): Promise<Buffer> => {
    while (pending.length < length) {
      const next = await iterator.next();
      if (next.done === true) throw corrupt('Native messaging frame ended before its declared length.');
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
      pending = Buffer.concat([pending, chunk], pending.length + chunk.length);
      if (pending.length > INTEROP_CONTROL_FRAME_BYTES + HEADER_BYTES) {
        throw corrupt('Native messaging frame exceeds the control-frame limit.');
      }
    }
    const value = pending.subarray(0, length);
    pending = pending.subarray(length);
    return value;
  };
  const header = await readExactly(HEADER_BYTES);
  const length = header.readUInt32LE(0);
  if (length > INTEROP_CONTROL_FRAME_BYTES) throw corrupt('Native messaging frame exceeds the control-frame limit.');
  const payload = await readExactly(length);
  if (pending.length > 0 || input.readableLength > 0) {
    throw corrupt('Native messaging frame contains trailing bytes.');
  }
  try {
    const value = JSON.parse(payload.toString('utf8')) as unknown;
    assertBoundedControlFrame(value);
    return value;
  } catch (error) {
    if (error instanceof InteropTransportError) throw error;
    throw corrupt('Native messaging frame is malformed.');
  }
}

export function encodeNativeMessage(value: NativeMessageResponse): Buffer {
  assertBoundedControlFrame(value);
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length > INTEROP_CONTROL_FRAME_BYTES) throw corrupt('Native messaging response exceeds the control-frame limit.');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export async function writeNativeMessage(output: Writable, value: NativeMessageResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(encodeNativeMessage(value), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function nativeMessageFailure(error: unknown): NativeMessageResponse {
  if (error instanceof InteropTransportError) {
    return { schemaVersion: 1, ok: false, code: error.code, retryable: error.retryable };
  }
  return { schemaVersion: 1, ok: false, code: 'unavailable', retryable: true };
}

export async function runNativeMessage(
  input: Readable,
  output: Writable,
  handle: (value: unknown) => Promise<NativeMessageResponse>,
): Promise<void> {
  let response: NativeMessageResponse;
  try {
    response = await handle(await readNativeMessage(input));
  } catch (error) {
    response = nativeMessageFailure(error);
  }
  await writeNativeMessage(output, response);
}
