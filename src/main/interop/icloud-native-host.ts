import { z } from 'zod';

import { OVERLOOK_ICLOUD_NATIVE_HOST } from '../../shared/app-identity.js';
import { InteropTransportError, assertBoundedControlFrame, assertSafeInteropPath } from './transport.js';

export { OVERLOOK_ICLOUD_NATIVE_HOST } from '../../shared/app-identity.js';

const extensionIdSchema = z.string().regex(/^[a-p]{32}$/u);
const fileReferenceSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const requestSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.enum(['status', 'put-file', 'materialize-file', 'list', 'delete', 'quota', 'verify']),
    extensionId: extensionIdSchema,
    path: z.string().optional(),
    sourceFile: fileReferenceSchema.optional(),
    destinationFile: fileReferenceSchema.optional(),
    cursor: z.string().nullable().optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const pathRequired = ['put-file', 'materialize-file', 'list', 'delete', 'verify'].includes(request.operation);
    if (pathRequired && request.path === undefined)
      context.addIssue({ code: 'custom', message: `${request.operation} requires an iCloud interoperability path.` });
    if (request.path !== undefined) {
      try {
        assertSafeInteropPath(request.path);
      } catch {
        context.addIssue({ code: 'custom', message: 'Unsafe iCloud interoperability path.' });
      }
    }
    if (request.operation === 'put-file' && request.sourceFile === undefined)
      context.addIssue({ code: 'custom', message: 'put-file requires an encrypted source file reference.' });
    if (request.operation === 'materialize-file' && request.destinationFile === undefined)
      context.addIssue({ code: 'custom', message: 'materialize-file requires an encrypted destination file reference.' });
  });

export type ICloudNativeRequest = z.output<typeof requestSchema>;

export interface ICloudNativeAuthority {
  status(): Promise<unknown>;
  putFile(path: string, sourceFile: string): Promise<unknown>;
  materializeFile(path: string, destinationFile: string): Promise<unknown>;
  list(path: string, cursor: string | null): Promise<unknown>;
  delete(path: string): Promise<unknown>;
  quota(): Promise<unknown>;
  verify(path: string): Promise<unknown>;
}

export interface ICloudNativeHostOptions {
  readonly expectedExtensionId: string;
  readonly platform: NodeJS.Platform;
  readonly signed: boolean;
  readonly entitled: boolean;
  readonly iCloudAvailable: boolean;
  readonly authority: ICloudNativeAuthority;
}

export interface NativeHostManifest {
  readonly name: typeof OVERLOOK_ICLOUD_NATIVE_HOST;
  readonly description: string;
  readonly path: string;
  readonly type: 'stdio';
  readonly allowed_origins: readonly string[];
}

export function nativeHostManifest(executablePath: string, releasedExtensionId: string): NativeHostManifest {
  if (!executablePath.startsWith('/')) throw new InteropTransportError('Native host executable path must be absolute.', 'corrupt', false);
  const extensionId = extensionIdSchema.parse(releasedExtensionId);
  return {
    name: OVERLOOK_ICLOUD_NATIVE_HOST,
    description: 'Signed Overlook iCloud interoperability host',
    path: executablePath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

function responseError(error: unknown): { schemaVersion: 1; ok: false; code: string; retryable: boolean } {
  if (error instanceof InteropTransportError) return { schemaVersion: 1, ok: false, code: error.code, retryable: error.retryable };
  return { schemaVersion: 1, ok: false, code: 'unavailable', retryable: true };
}

/**
 * Security boundary used by the signed stdio executable. It accepts only
 * bounded control frames and file references; ciphertext bytes never enter
 * native messaging JSON.
 */
export class ICloudNativeHost {
  constructor(private readonly options: ICloudNativeHostOptions) {}

  async handle(value: unknown): Promise<{
    readonly schemaVersion: 1;
    readonly ok: boolean;
    readonly result?: unknown;
    readonly code?: string;
    readonly retryable?: boolean;
  }> {
    try {
      if (this.options.platform !== 'darwin')
        throw new InteropTransportError('iCloud interoperability requires macOS.', 'unsupported', false);
      if (!this.options.signed || !this.options.entitled)
        throw new InteropTransportError('Native host signature or iCloud entitlement is invalid.', 'unsupported', false);
      if (!this.options.iCloudAvailable) throw new InteropTransportError('iCloud is unavailable.', 'provider-unavailable', true);
      assertBoundedControlFrame(value);
      const request = requestSchema.parse(value);
      if (request.extensionId !== this.options.expectedExtensionId)
        throw new InteropTransportError('Native host rejected the extension identity.', 'unsupported', false);
      const result = await this.dispatch(request);
      const response = { schemaVersion: 1 as const, ok: true, result };
      assertBoundedControlFrame(response);
      return response;
    } catch (error) {
      return responseError(error);
    }
  }

  private dispatch(request: ICloudNativeRequest): Promise<unknown> {
    const path = request.path ?? '';
    switch (request.operation) {
      case 'status':
        return this.options.authority.status();
      case 'put-file':
        return this.options.authority.putFile(path, request.sourceFile as string);
      case 'materialize-file':
        return this.options.authority.materializeFile(path, request.destinationFile as string);
      case 'list':
        return this.options.authority.list(path, request.cursor ?? null);
      case 'delete':
        return this.options.authority.delete(path);
      case 'quota':
        return this.options.authority.quota();
      case 'verify':
        return this.options.authority.verify(path);
    }
  }
}
