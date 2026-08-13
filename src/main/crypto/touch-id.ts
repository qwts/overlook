import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { OVERLOOK_MAC_BUNDLE_ID } from '../../shared/app-identity.js';
import type { AppLockCredentialStore, CredentialAnchor, MasterReleaseResult, UnlockKeyResult } from './app-lock-credentials.js';

const MARKER_FILE = 'touch-id.json';
const MARKER_VERSION = 2;

export type TouchIdUnavailableReason =
  'unsupported-platform' | 'unsigned-build' | 'native-unavailable' | 'not-enrolled' | 'locked-out' | 'unavailable';

export type TouchIdAdapterErrorCode = 'cancelled' | 'failed' | 'locked-out' | 'unavailable' | 'missing' | 'storage-failure';

export interface TouchIdAvailability {
  readonly available: boolean;
  readonly reason: TouchIdUnavailableReason | null;
}

export interface TouchIdStatus extends TouchIdAvailability {
  readonly enabled: boolean;
  readonly reenrollmentRequired: boolean;
}

export class TouchIdAdapterError extends Error {
  override readonly name = 'TouchIdAdapterError';

  constructor(readonly code: TouchIdAdapterErrorCode) {
    super('Touch ID operation failed');
  }
}

export interface TouchIdSecureAdapter {
  availability(): TouchIdAvailability;
  store(account: string, secret: Buffer): Promise<void>;
  read(account: string, reason: string): Promise<Buffer>;
  clear(account: string): Promise<void>;
}

export type TouchIdEnableResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'wrong-password' | 'recovery-required' | TouchIdUnavailableReason };

export type TouchIdUnlockFailureReason =
  'not-enabled' | 'cancelled' | 'failed' | 'locked-out' | 'unavailable' | 'enrollment-changed' | 'recovery-required';

export type TouchIdUnlockResult =
  { readonly ok: true; readonly masterKey: Buffer } | { readonly ok: false; readonly reason: TouchIdUnlockFailureReason };

type CredentialSource = Pick<AppLockCredentialStore, 'releaseUnlockKey' | 'unlockWithKey'> &
  Partial<Pick<AppLockCredentialStore, 'recordAnchor' | 'anchor'>>;

function credentialIdentity(credentials: CredentialSource): CredentialAnchor | null {
  return credentials.recordAnchor?.() ?? credentials.anchor?.() ?? null;
}

const markerFields = {
  account: z.string().regex(/^v1:[a-f0-9]{64}$/u),
  libraryId: z.string().min(1).max(256),
  generation: z.number().int().positive(),
  recordHash: z.string().regex(/^[a-f0-9]{64}$/u),
};

const legacyMarkerSchema = z
  .object({
    version: z.literal(1),
    ...markerFields,
  })
  .strict();

const currentMarkerSchema = z
  .object({
    version: z.literal(MARKER_VERSION),
    bundleId: z.literal(OVERLOOK_MAC_BUNDLE_ID),
    ...markerFields,
  })
  .strict();

const markerSchema = z.union([legacyMarkerSchema, currentMarkerSchema]);
type TouchIdMarker = z.output<typeof currentMarkerSchema>;
type StoredTouchIdMarker = z.output<typeof markerSchema>;

function markerFor(anchor: CredentialAnchor): TouchIdMarker {
  return {
    version: MARKER_VERSION,
    bundleId: OVERLOOK_MAC_BUNDLE_ID,
    account: `v1:${anchor.recordHash}`,
    libraryId: anchor.libraryId,
    generation: anchor.generation,
    recordHash: anchor.recordHash,
  };
}

function matches(marker: StoredTouchIdMarker, anchor: CredentialAnchor | null): boolean {
  return (
    anchor !== null &&
    marker.libraryId === anchor.libraryId &&
    marker.generation === anchor.generation &&
    marker.recordHash === anchor.recordHash
  );
}

function sameAnchor(left: CredentialAnchor, right: CredentialAnchor | null): boolean {
  return (
    right !== null && left.libraryId === right.libraryId && left.generation === right.generation && left.recordHash === right.recordHash
  );
}

function operationReason(error: unknown): TouchIdUnlockFailureReason {
  if (!(error instanceof TouchIdAdapterError)) return 'unavailable';
  switch (error.code) {
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'locked-out':
      return 'locked-out';
    case 'missing':
      return 'enrollment-changed';
    case 'unavailable':
    case 'storage-failure':
      return 'unavailable';
  }
}

/** Coordinates non-secret enrollment state with device-only native custody.
 * The marker is only an enablement pointer; U and M never enter this file. */
export class TouchIdService {
  private readonly markerPath: string;

  constructor(
    dataDir: string,
    private readonly adapter: TouchIdSecureAdapter,
    private readonly credentials: CredentialSource,
  ) {
    this.markerPath = join(dataDir, MARKER_FILE);
  }

  async status(): Promise<TouchIdStatus> {
    const marker = this.readMarker();
    const anchor = credentialIdentity(this.credentials);
    if (marker !== null && !matches(marker, anchor)) {
      await this.revoke(marker);
    }
    const current = this.readMarker();
    const availability = this.adapter.availability();
    return {
      ...availability,
      enabled: current?.version === MARKER_VERSION && matches(current, anchor),
      reenrollmentRequired: current?.version === 1 && matches(current, anchor),
    };
  }

  async enable(password: string): Promise<TouchIdEnableResult> {
    const availability = this.adapter.availability();
    if (!availability.available) return { ok: false, reason: availability.reason ?? 'unavailable' };
    const anchor = credentialIdentity(this.credentials);
    if (anchor === null) return { ok: false, reason: 'recovery-required' };
    const released: UnlockKeyResult = await this.credentials.releaseUnlockKey(password);
    if (!released.ok) {
      if (released.reason === 'storage-unavailable') return { ok: false, reason: 'unavailable' };
      return { ok: false, reason: released.reason };
    }
    try {
      const currentAnchor = credentialIdentity(this.credentials);
      if (!sameAnchor(anchor, currentAnchor)) return { ok: false, reason: 'recovery-required' };
      const marker = markerFor(anchor);
      const previous = this.readMarker();
      if (previous !== null && (previous.version === 1 || previous.account !== marker.account)) await this.revoke(previous);
      await this.adapter.store(marker.account, released.unlockKey);
      this.writeMarker(marker);
      return { ok: true };
    } catch {
      await this.bestEffortClear(`v1:${anchor.recordHash}`);
      const marker = this.readMarker();
      if (marker?.account === `v1:${anchor.recordHash}`) this.removeMarker();
      return { ok: false, reason: 'unavailable' };
    } finally {
      released.unlockKey.fill(0);
    }
  }

  async disable(): Promise<boolean> {
    const marker = this.readMarker();
    if (marker === null) return true;
    if (marker.version === 1) {
      this.removeMarker();
      return true;
    }
    try {
      await this.adapter.clear(marker.account);
      this.removeMarker();
      return true;
    } catch {
      return false;
    }
  }

  async unlockMaster(): Promise<TouchIdUnlockResult> {
    const status = await this.status();
    if (!status.enabled) return { ok: false, reason: 'not-enabled' };
    if (!status.available) return { ok: false, reason: status.reason === 'locked-out' ? 'locked-out' : 'unavailable' };
    const marker = this.readMarker();
    if (marker === null) return { ok: false, reason: 'not-enabled' };
    let unlockKey: Buffer | undefined;
    try {
      unlockKey = await this.adapter.read(marker.account, 'Unlock Overlook');
      const released: MasterReleaseResult = this.credentials.unlockWithKey(unlockKey);
      if (released.ok) return released;
      if (released.reason === 'storage-unavailable') return { ok: false, reason: 'unavailable' };
      await this.revoke(marker);
      return { ok: false, reason: released.reason === 'recovery-required' ? 'recovery-required' : 'enrollment-changed' };
    } catch (error) {
      const reason = operationReason(error);
      if (reason === 'enrollment-changed') await this.revoke(marker);
      return { ok: false, reason };
    } finally {
      unlockKey?.fill(0);
    }
  }

  /** Credential rotation makes the old U cryptographically useless. This
   * eagerly removes its native item and marker; a crash is reconciled by status(). */
  async credentialsChanged(): Promise<void> {
    const marker = this.readMarker();
    if (marker !== null && !matches(marker, credentialIdentity(this.credentials))) await this.revoke(marker);
  }

  private readMarker(): StoredTouchIdMarker | null {
    if (!existsSync(this.markerPath)) return null;
    try {
      return markerSchema.parse(JSON.parse(readFileSync(this.markerPath, 'utf8')) as unknown);
    } catch {
      this.removeMarker();
      return null;
    }
  }

  private writeMarker(marker: TouchIdMarker): void {
    mkdirSync(dirname(this.markerPath), { recursive: true });
    const temporary = `${this.markerPath}.tmp`;
    writeFileSync(temporary, Buffer.from(JSON.stringify(marker), 'utf8'), { mode: 0o600 });
    renameSync(temporary, this.markerPath);
  }

  private removeMarker(): void {
    if (existsSync(this.markerPath)) unlinkSync(this.markerPath);
  }

  private async revoke(marker: StoredTouchIdMarker): Promise<void> {
    if (marker.version === MARKER_VERSION) await this.bestEffortClear(marker.account);
    this.removeMarker();
  }

  private async bestEffortClear(account: string): Promise<void> {
    try {
      await this.adapter.clear(account);
    } catch {
      // The marker is removed by the caller so this app cannot request the
      // orphan again; credential rotation also makes stale U unusable.
    }
  }
}
