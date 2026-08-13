import type { AppLockCredentialStore, AppLockStatus, ConfigureAppLockInput } from './app-lock-credentials.js';
import type { TouchIdEnableResult, TouchIdService, TouchIdStatus, TouchIdUnlockFailureReason } from './touch-id.js';
import type { UnlockThrottle } from './unlock-throttle.js';

export type AppLockState = 'unconfigured-unlocked' | 'locked' | 'unlocking' | 'unlocked' | 'locking' | 'recovery-required';

export class AppLockedError extends Error {
  override readonly name = 'AppLockedError';
  readonly code = 'app-locked';
}

export interface AppLockControllerOptions {
  readonly credentials: Pick<AppLockCredentialStore, 'status' | 'configure' | 'unlock' | 'changePassword' | 'recover' | 'remove'>;
  readonly openAuthorized: (masterKey?: Buffer) => void | Promise<void>;
  readonly closeAuthorized: () => void | Promise<void>;
  readonly failClosed?: () => void;
  readonly throttle?: Pick<UnlockThrottle, 'remainingMs' | 'recordFailure' | 'reset'>;
  readonly touchId?: Pick<TouchIdService, 'status' | 'enable' | 'disable' | 'unlockMaster' | 'credentialsChanged'>;
  readonly classifyOpenError?: (error: unknown) => 'library-in-use' | undefined;
}

export interface LockStateSnapshot {
  readonly state: AppLockState;
  readonly libraryId: string | null;
}

export type AppUnlockResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'wrong-password' | 'recovery-required' | 'throttled' | 'library-in-use';
      readonly retryAfterMs?: number;
    };

export type AppAuthorizationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'wrong-password' | 'recovery-required' | 'throttled'; readonly retryAfterMs?: number };

export type AppTouchIdUnlockResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: TouchIdUnlockFailureReason | 'library-in-use' };

export class AppLockController {
  private current: LockStateSnapshot;
  private transition: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: LockStateSnapshot) => void>();
  private readonly touchIdListeners = new Set<(status: TouchIdStatus) => void>();

  constructor(private readonly options: AppLockControllerOptions) {
    this.current = this.fromCredentialStatus(options.credentials.status());
  }

  snapshot(): LockStateSnapshot {
    return { ...this.current };
  }

  retryAfterMs(): number {
    return this.options.throttle?.remainingMs() ?? 0;
  }

  subscribe(listener: (snapshot: LockStateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTouchId(listener: (status: TouchIdStatus) => void): () => void {
    this.touchIdListeners.add(listener);
    return () => this.touchIdListeners.delete(listener);
  }

  touchIdStatus(): Promise<TouchIdStatus> {
    return (
      this.options.touchId?.status() ??
      Promise.resolve({ available: false, reason: 'unsupported-platform', enabled: false, reenrollmentRequired: false })
    );
  }

  initialize(): Promise<void> {
    return this.serialize(async () => {
      if (this.current.state === 'unconfigured-unlocked') await this.options.openAuthorized();
    });
  }

  requireContentAccess(): void {
    if (this.current.state !== 'unlocked' && this.current.state !== 'unconfigured-unlocked') {
      throw new AppLockedError('App is locked');
    }
  }

  unlock(password: string): Promise<AppUnlockResult> {
    return this.serialize(async () => {
      if (this.current.state !== 'locked') return { ok: false, reason: 'recovery-required' };
      const remaining = this.options.throttle?.remainingMs() ?? 0;
      if (remaining > 0) return { ok: false, reason: 'throttled', retryAfterMs: remaining };
      this.publish({ ...this.current, state: 'unlocking' });
      const result = await this.options.credentials.unlock(password);
      if (!result.ok) {
        try {
          const retryAfterMs = result.reason === 'wrong-password' ? this.options.throttle?.recordFailure() : undefined;
          return { ...result, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
        } finally {
          this.publish({ ...this.current, state: result.reason === 'recovery-required' ? 'recovery-required' : 'locked' });
        }
      }
      try {
        this.options.throttle?.reset();
        await this.options.openAuthorized(result.masterKey);
        this.publish({ ...this.current, state: 'unlocked' });
        return { ok: true };
      } catch (error) {
        this.publish({ ...this.current, state: 'locked' });
        return { ok: false, reason: this.options.classifyOpenError?.(error) ?? 'recovery-required' };
      } finally {
        result.masterKey.fill(0);
      }
    });
  }

  /** Re-authenticates an already-open app without changing lock state. */
  authorize(password: string): Promise<AppAuthorizationResult> {
    return this.serialize(async () => {
      this.requireContentAccess();
      if (this.current.state === 'unconfigured-unlocked') return { ok: true };
      const remaining = this.options.throttle?.remainingMs() ?? 0;
      if (remaining > 0) return { ok: false, reason: 'throttled', retryAfterMs: remaining };
      const result = await this.options.credentials.unlock(password);
      if (!result.ok) {
        const retryAfterMs = result.reason === 'wrong-password' ? this.options.throttle?.recordFailure() : undefined;
        return { ...result, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
      }
      try {
        this.options.throttle?.reset();
        return { ok: true };
      } finally {
        result.masterKey.fill(0);
      }
    });
  }

  unlockWithTouchId(): Promise<AppTouchIdUnlockResult> {
    return this.serialize(async () => {
      if (this.current.state !== 'locked') return { ok: false, reason: 'recovery-required' };
      if (this.options.touchId === undefined) return { ok: false, reason: 'not-enabled' };
      this.publish({ ...this.current, state: 'unlocking' });
      const result = await this.options.touchId.unlockMaster().catch(() => ({ ok: false as const, reason: 'unavailable' as const }));
      if (!result.ok) {
        this.publish({ ...this.current, state: result.reason === 'recovery-required' ? 'recovery-required' : 'locked' });
        if (result.reason === 'enrollment-changed' || result.reason === 'recovery-required') await this.publishTouchId();
        return result;
      }
      try {
        await this.options.openAuthorized(result.masterKey);
        this.publish({ ...this.current, state: 'unlocked' });
        return { ok: true };
      } catch (error) {
        this.publish({ ...this.current, state: 'locked' });
        return { ok: false, reason: this.options.classifyOpenError?.(error) ?? 'recovery-required' };
      } finally {
        result.masterKey.fill(0);
      }
    });
  }

  enableTouchId(password: string): Promise<TouchIdEnableResult> {
    return this.serialize(async () => {
      this.requireContentAccess();
      const result =
        this.options.touchId === undefined
          ? ({ ok: false, reason: 'unsupported-platform' } as const)
          : await this.options.touchId.enable(password);
      if (result.ok) await this.publishTouchId();
      return result;
    });
  }

  disableTouchId(): Promise<boolean> {
    return this.serialize(async () => {
      this.requireContentAccess();
      const disabled = this.options.touchId === undefined || (await this.options.touchId.disable());
      if (disabled) await this.publishTouchId();
      return disabled;
    });
  }

  lock(): Promise<void> {
    return this.serialize(async () => {
      if (this.current.state !== 'unlocked') return;
      this.publish({ ...this.current, state: 'locking' });
      try {
        await this.options.closeAuthorized();
      } catch {
        this.options.failClosed?.();
      } finally {
        this.publish({ ...this.current, state: 'locked' });
      }
    });
  }

  configure(input: ConfigureAppLockInput): Promise<void> {
    return this.serialize(async () => {
      if (this.current.state !== 'unconfigured-unlocked') throw new AppLockedError('App lock cannot be configured in this state');
      await this.options.credentials.configure(input);
      this.publish({ state: 'locking', libraryId: input.libraryId });
      try {
        await this.options.closeAuthorized();
      } catch {
        this.options.failClosed?.();
      } finally {
        this.publish({ state: 'locked', libraryId: input.libraryId });
      }
    });
  }

  changePassword(currentPassword: string, nextPassword: string): Promise<boolean> {
    return this.serialize(async () => {
      this.requireContentAccess();
      const changed = await this.options.credentials.changePassword(currentPassword, nextPassword);
      if (changed) await this.credentialsChanged();
      return changed;
    });
  }

  remove(password: string): Promise<boolean> {
    return this.serialize(async () => {
      this.requireContentAccess();
      const removed = await this.options.credentials.remove(password);
      if (removed) {
        await this.credentialsChanged();
        this.publish({ state: 'unconfigured-unlocked', libraryId: null });
      }
      return removed;
    });
  }

  recover(input: ConfigureAppLockInput): Promise<void> {
    return this.serialize(async () => {
      if (this.current.state !== 'locked' && this.current.state !== 'recovery-required') {
        throw new AppLockedError('App lock recovery requires a closed library');
      }
      await this.options.credentials.recover(input);
      await this.credentialsChanged();
      this.publish({ state: 'locked', libraryId: input.libraryId });
    });
  }

  private fromCredentialStatus(status: AppLockStatus): LockStateSnapshot {
    if (status.state === 'unconfigured') return { state: 'unconfigured-unlocked', libraryId: null };
    if (status.state === 'locked') return { state: 'locked', libraryId: status.libraryId };
    return { state: 'recovery-required', libraryId: null };
  }

  private publish(snapshot: LockStateSnapshot): void {
    this.current = snapshot;
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        // Observer delivery is best-effort and must never interrupt custody transitions.
      }
    }
  }

  private async credentialsChanged(): Promise<void> {
    try {
      await this.options.touchId?.credentialsChanged();
    } catch {
      // Rotation already makes the old U unable to open the new credential
      // record. Startup/status reconciliation retries physical cleanup.
    }
    await this.publishTouchId();
  }

  private async publishTouchId(): Promise<void> {
    const status = await this.touchIdStatus().catch(() => ({
      available: false as const,
      reason: 'native-unavailable' as const,
      enabled: false,
      reenrollmentRequired: false,
    }));
    for (const listener of this.touchIdListeners) {
      try {
        listener(status);
      } catch {
        // Observer delivery cannot interrupt custody transitions.
      }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation);
    this.transition = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
