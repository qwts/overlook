import { tmpdir } from 'node:os';

import { z } from 'zod';

import { liveLocalRuntimeDirectory, requestUnixLiveLocalControl } from './live-local-control.js';
import {
  prepareUnixControlEndpoint,
  parseLiveLocalBootstrapRequest,
  parseLiveLocalBootstrapResult,
  type LiveLocalBootstrapRequest,
  type LiveLocalBootstrapResult,
} from './live-local-security.js';
import { InteropTransportError } from './transport.js';

const nativeBootstrapRequestSchema = z
  .object({
    schemaVersion: z.literal(2),
    operation: z.literal('live-local-bootstrap'),
    request: z.unknown(),
  })
  .strict();

const controlReplySchema = z.discriminatedUnion('ok', [
  z.object({ schemaVersion: z.literal(1), ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      ok: z.literal(false),
      code: z.enum(['corrupt', 'unsupported']),
      retryable: z.literal(false),
    })
    .strict(),
]);

export interface LiveLocalNativeBootstrapRequest {
  readonly schemaVersion: 2;
  readonly operation: 'live-local-bootstrap';
  readonly request: LiveLocalBootstrapRequest;
}

export function isLiveLocalNativeBootstrapRequest(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operation' in value &&
    (value as { readonly operation?: unknown }).operation === 'live-local-bootstrap'
  );
}

export function parseLiveLocalNativeBootstrapRequest(value: unknown): LiveLocalNativeBootstrapRequest {
  const outer = nativeBootstrapRequestSchema.safeParse(value);
  if (!outer.success) throw new InteropTransportError('Live local native bootstrap request is corrupt.', 'corrupt', false);
  return { ...outer.data, request: parseLiveLocalBootstrapRequest(outer.data.request) };
}

export interface RequestLiveLocalBootstrapOptions {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly profileDirectory: string;
  readonly expectedExtensionId: string;
  readonly temporaryDirectory?: string;
}

export async function requestLiveLocalBootstrap(
  value: unknown,
  options: RequestLiveLocalBootstrapOptions,
): Promise<LiveLocalBootstrapResult> {
  if (options.platform !== 'darwin' || !options.packaged)
    throw new InteropTransportError('Live local bootstrap is unavailable on this build.', 'unsupported', false);
  const nativeRequest = parseLiveLocalNativeBootstrapRequest(value);
  if (nativeRequest.request.extensionId !== options.expectedExtensionId)
    throw new InteropTransportError('Live local native host rejected the extension identity.', 'unsupported', false);
  const runtimeDirectory = liveLocalRuntimeDirectory(options.profileDirectory, options.temporaryDirectory ?? tmpdir());
  const endpoint = await prepareUnixControlEndpoint(runtimeDirectory);
  try {
    const reply = controlReplySchema.parse(await requestUnixLiveLocalControl(endpoint, nativeRequest.request));
    if (!reply.ok) throw new InteropTransportError('Live local desktop rejected the bootstrap.', reply.code, reply.retryable);
    return parseLiveLocalBootstrapResult(reply.result);
  } catch (error) {
    if (error instanceof InteropTransportError) throw error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ECONNREFUSED') return { schemaVersion: 1, state: 'not-running' };
    return { schemaVersion: 1, state: 'unavailable' };
  }
}
