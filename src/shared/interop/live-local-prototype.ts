import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import { interopOperationSchema } from './contract.js';

export const LIVE_LOCAL_PROTOCOL_VERSION = 1;
export const LIVE_LOCAL_CAPABILITY_TTL_MS = 15_000;
export const LIVE_LOCAL_CONTROL_FRAME_BYTES = 64 * 1024;
export const LIVE_LOCAL_CIPHERTEXT_FRAME_BYTES = 4 * 1024 * 1024;
export const LIVE_LOCAL_IN_FLIGHT_BYTES = 8 * 1024 * 1024;

const extensionIdSchema = z.string().regex(/^[a-p]{32}$/u);
const bootstrapRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    extensionId: extensionIdSchema,
    pairingId: z.string().uuid(),
    operation: interopOperationSchema,
    protocolMin: z.number().int().positive(),
    protocolMax: z.number().int().positive(),
  })
  .strict()
  .refine((request) => request.protocolMin <= request.protocolMax, 'Invalid protocol version range.');

const redemptionSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('redeem'),
    sessionId: z.string().uuid(),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    extensionId: extensionIdSchema,
    pairingId: z.string().uuid(),
    operation: interopOperationSchema,
    protocolVersion: z.number().int().positive(),
  })
  .strict();

export type LiveLocalBootstrapState = 'running' | 'not-running' | 'locked' | 'incompatible' | 'unavailable';
export type LiveLocalPrototypeFailure = 'corrupt' | 'replay' | 'expired' | 'unsupported' | 'wrong-authority' | 'over-budget';
export type LiveLocalBootstrapRequest = z.output<typeof bootstrapRequestSchema>;
export type LiveLocalRedemption = z.output<typeof redemptionSchema>;

export interface LiveLocalCapability {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly secret: string;
  readonly endpoint: string;
  readonly extensionId: string;
  readonly pairingId: string;
  readonly operation: LiveLocalBootstrapRequest['operation'];
  readonly protocolVersion: number;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly maxCiphertextFrameBytes: number;
  readonly maxInFlightBytes: number;
}

export type LiveLocalBootstrapResult =
  | { readonly schemaVersion: 1; readonly state: Exclude<LiveLocalBootstrapState, 'running'> }
  | { readonly schemaVersion: 1; readonly state: 'running'; readonly capability: LiveLocalCapability };

interface StoredCapability {
  readonly secretDigest: Buffer;
  readonly extensionId: string;
  readonly pairingId: string;
  readonly operation: LiveLocalBootstrapRequest['operation'];
  readonly protocolVersion: number;
  readonly expiresAtMs: number;
}

export class LiveLocalPrototypeError extends Error {
  constructor(
    message: string,
    readonly code: LiveLocalPrototypeFailure,
  ) {
    super(message);
    this.name = 'LiveLocalPrototypeError';
  }
}

export interface LiveLocalCapabilityBrokerOptions {
  readonly expectedExtensionId: string;
  readonly endpoint: string;
  readonly now?: () => number;
  readonly random?: (bytes: number) => Buffer;
}

function boundedControlValue(value: unknown): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new LiveLocalPrototypeError('Live local control frame is not JSON.', 'corrupt');
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > LIVE_LOCAL_CONTROL_FRAME_BYTES)
    throw new LiveLocalPrototypeError('Live local control frame exceeds its bound.', 'over-budget');
}

function secretDigest(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function constantTimeMatch(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function uuidFrom(bytes: Buffer): string {
  const value = Buffer.from(bytes.subarray(0, 16));
  value[6] = ((value[6] as number) & 0x0f) | 0x40;
  value[8] = ((value[8] as number) & 0x3f) | 0x80;
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Test-only ADR-0029 capability prototype. No production composition root
 * imports this module; #544 owns that decision after the ADR is accepted.
 */
export class LiveLocalCapabilityBroker {
  private readonly expectedExtensionId: string;
  private readonly endpoint: string;
  private readonly now: () => number;
  private readonly random: (bytes: number) => Buffer;
  private readonly capabilities = new Map<string, StoredCapability>();

  constructor(options: LiveLocalCapabilityBrokerOptions) {
    this.expectedExtensionId = extensionIdSchema.parse(options.expectedExtensionId);
    this.endpoint = z.string().url().startsWith('ws://127.0.0.1:').parse(options.endpoint);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
  }

  issue(state: LiveLocalBootstrapState, value: unknown): LiveLocalBootstrapResult {
    boundedControlValue(value);
    const request = bootstrapRequestSchema.parse(value);
    if (request.extensionId !== this.expectedExtensionId)
      throw new LiveLocalPrototypeError('Live local bootstrap rejected the extension authority.', 'wrong-authority');
    if (state !== 'running') return { schemaVersion: 1, state };
    if (request.protocolMin > LIVE_LOCAL_PROTOCOL_VERSION || request.protocolMax < LIVE_LOCAL_PROTOCOL_VERSION)
      return { schemaVersion: 1, state: 'incompatible' };

    const now = this.now();
    const sessionId = uuidFrom(this.random(16));
    const secret = this.random(32).toString('base64url');
    const capability: LiveLocalCapability = {
      schemaVersion: 1,
      sessionId,
      secret,
      endpoint: `${this.endpoint}/session/${sessionId}`,
      extensionId: request.extensionId,
      pairingId: request.pairingId,
      operation: request.operation,
      protocolVersion: LIVE_LOCAL_PROTOCOL_VERSION,
      issuedAtMs: now,
      expiresAtMs: now + LIVE_LOCAL_CAPABILITY_TTL_MS,
      maxCiphertextFrameBytes: LIVE_LOCAL_CIPHERTEXT_FRAME_BYTES,
      maxInFlightBytes: LIVE_LOCAL_IN_FLIGHT_BYTES,
    };
    this.capabilities.set(sessionId, {
      secretDigest: secretDigest(secret),
      extensionId: request.extensionId,
      pairingId: request.pairingId,
      operation: request.operation,
      protocolVersion: LIVE_LOCAL_PROTOCOL_VERSION,
      expiresAtMs: capability.expiresAtMs,
    });
    boundedControlValue(capability);
    return { schemaVersion: 1, state: 'running', capability };
  }

  redeem(value: unknown): LiveLocalRedemption {
    boundedControlValue(value);
    const identity = z.object({ sessionId: z.string().uuid() }).passthrough().parse(value);
    const stored = this.capabilities.get(identity.sessionId);
    if (stored === undefined) throw new LiveLocalPrototypeError('Live local capability was already consumed.', 'replay');

    // Lookup and consumption are one synchronous operation. Every failure
    // after a session identifier is recognized burns the capability.
    this.capabilities.delete(identity.sessionId);
    const redemption = redemptionSchema.parse(value);
    if (this.now() > stored.expiresAtMs) throw new LiveLocalPrototypeError('Live local capability expired.', 'expired');
    if (
      redemption.extensionId !== stored.extensionId ||
      redemption.pairingId !== stored.pairingId ||
      redemption.operation !== stored.operation
    )
      throw new LiveLocalPrototypeError('Live local capability authority did not match.', 'wrong-authority');
    if (redemption.protocolVersion !== stored.protocolVersion)
      throw new LiveLocalPrototypeError('Live local protocol downgrade was rejected.', 'unsupported');
    if (!constantTimeMatch(secretDigest(redemption.secret), stored.secretDigest))
      throw new LiveLocalPrototypeError('Live local capability secret did not match.', 'wrong-authority');
    return redemption;
  }
}

interface WaitingReservation {
  readonly bytes: number;
  readonly resolve: (release: () => void) => void;
}

/** Prototype sender-side byte window. It blocks producers before accepting a
 * frame that would exceed the negotiated in-flight budget. */
export class LiveLocalBackpressureWindow {
  private inFlightBytes = 0;
  private peakInFlightBytes = 0;
  private readonly waiting: WaitingReservation[] = [];

  constructor(
    readonly maxFrameBytes = LIVE_LOCAL_CIPHERTEXT_FRAME_BYTES,
    readonly maxInFlightBytes = LIVE_LOCAL_IN_FLIGHT_BYTES,
  ) {
    if (maxFrameBytes <= 0 || maxInFlightBytes < maxFrameBytes)
      throw new LiveLocalPrototypeError('Invalid live local byte-window bounds.', 'corrupt');
  }

  get inFlight(): number {
    return this.inFlightBytes;
  }

  get peakInFlight(): number {
    return this.peakInFlightBytes;
  }

  reserve(bytes: number): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.maxFrameBytes)
      throw new LiveLocalPrototypeError('Ciphertext frame exceeds its negotiated bound.', 'over-budget');
    return new Promise<() => void>((resolve) => {
      this.waiting.push({ bytes, resolve });
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const next = this.waiting[0] as WaitingReservation;
      if (this.inFlightBytes + next.bytes > this.maxInFlightBytes) return;
      this.waiting.shift();
      this.inFlightBytes += next.bytes;
      this.peakInFlightBytes = Math.max(this.peakInFlightBytes, this.inFlightBytes);
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.inFlightBytes -= next.bytes;
        this.drain();
      });
    }
  }
}

const windowsSidSchema = z
  .string()
  .max(256)
  .regex(/^S-1-(?:\d+-){1,14}\d+$/u);

export interface WindowsNamedPipeSecurityContract {
  readonly path: string;
  readonly sddl: string;
}

export function windowsNamedPipeForUser(userSid: string): WindowsNamedPipeSecurityContract {
  const subject = windowsSidSchema.parse(userSid);
  const suffix = createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 24);
  return {
    path: `\\\\.\\pipe\\com.qwts.overlook.interop-${suffix}`,
    // Protected DACL: only the current user SID receives generic-all.
    sddl: `D:P(A;;GA;;;${subject})`,
  };
}

export async function prepareUnixControlEndpoint(runtimeDirectory: string): Promise<string> {
  if (!isAbsolute(runtimeDirectory)) throw new LiveLocalPrototypeError('Live local runtime directory must be absolute.', 'corrupt');
  const endpoint = join(runtimeDirectory, 'com.qwts.overlook.interop.sock');
  if (Buffer.byteLength(endpoint, 'utf8') > 103)
    throw new LiveLocalPrototypeError('Live local Unix socket path exceeds the platform bound.', 'corrupt');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const before = await lstat(runtimeDirectory);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new LiveLocalPrototypeError('Live local runtime directory is not an owned directory.', 'wrong-authority');
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && before.uid !== currentUid)
    throw new LiveLocalPrototypeError('Live local runtime directory belongs to another user.', 'wrong-authority');
  await chmod(runtimeDirectory, 0o700);
  return endpoint;
}

export function classifyControlEndpointFailure(error: unknown): 'not-running' | 'unavailable' {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED' ? 'not-running' : 'unavailable';
}
