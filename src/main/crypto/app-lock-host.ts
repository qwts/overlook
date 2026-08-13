import type {
  AppAuthorizationResult,
  AppLockController,
  AppSettingsMutationResult,
  AppTouchIdUnlockResult,
  AppUnlockResult,
  LockStateSnapshot,
} from './app-lock-controller.js';
import type { ConfigureAppLockInput } from './app-lock-credentials.js';
import type { TouchIdEnableResult, TouchIdStatus } from './touch-id.js';

// Swap-safe app-lock host (#385). The controller is dataDir-bound (credential
// store, anchor, Touch ID, throttle all live in one library directory), so a
// library switch needs a NEW controller — but IPC handlers, lifecycle
// listeners, and the external-open runtime bind once at startup. They bind to
// this host; a switch swaps the inner controller and the host re-attaches its
// subscriptions, so every consumer follows without re-registration. ADR-0013
// behavior is untouched: each inner controller is a stock createAppLockRuntime
// product for its own directory.

/** The controller surface consumers depend on — structural, so both the real
 * AppLockController and this host satisfy it. */
type CoreAppLockControllerLike = Pick<
  AppLockController,
  | 'initialize'
  | 'snapshot'
  | 'retryAfterMs'
  | 'subscribe'
  | 'subscribeTouchId'
  | 'touchIdStatus'
  | 'requireContentAccess'
  | 'unlock'
  | 'authorize'
  | 'unlockWithTouchId'
  | 'enableTouchId'
  | 'disableTouchId'
  | 'lock'
  | 'configure'
  | 'changePassword'
  | 'remove'
  | 'recover'
>;

export type AppLockControllerLike = CoreAppLockControllerLike &
  Partial<Pick<AppLockController, 'attemptsRemaining' | 'anchorPolicy' | 'setAnchorPolicy'>>;

export class AppLockHost implements AppLockControllerLike {
  private inner: AppLockControllerLike;
  private readonly stateListeners = new Set<(snapshot: LockStateSnapshot) => void>();
  private readonly touchIdListeners = new Set<(status: TouchIdStatus) => void>();
  private detach: () => void;
  private epoch = 0;

  constructor(initial: AppLockControllerLike) {
    this.inner = initial;
    this.detach = this.attach();
  }

  private attach(): () => void {
    const offState = this.inner.subscribe((snapshot) => {
      this.epoch += 1;
      for (const listener of this.stateListeners) listener(snapshot);
    });
    const offTouchId = this.inner.subscribeTouchId((status) => {
      for (const listener of this.touchIdListeners) listener(status);
    });
    return () => {
      offState();
      offTouchId();
    };
  }

  /** Replaces the inner controller (a switch pointed us at a new library
   * directory), initializes it, and notifies subscribers of the new state —
   * a lock-configured library lands 'locked' here. */
  async swap(next: AppLockControllerLike): Promise<void> {
    this.detach();
    this.inner = next;
    this.detach = this.attach();
    await next.initialize();
    const snapshot = next.snapshot();
    this.epoch += 1;
    for (const listener of this.stateListeners) listener(snapshot);
  }

  initialize(): Promise<void> {
    return this.inner.initialize();
  }
  snapshot(): LockStateSnapshot {
    return this.inner.snapshot();
  }
  retryAfterMs(): number {
    return this.inner.retryAfterMs();
  }
  attemptsRemaining(): number {
    return this.inner.attemptsRemaining?.() ?? 3;
  }
  authorizationEpoch(): number {
    return this.epoch;
  }
  subscribe(listener: (snapshot: LockStateSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  subscribeTouchId(listener: (status: TouchIdStatus) => void): () => void {
    this.touchIdListeners.add(listener);
    return () => this.touchIdListeners.delete(listener);
  }
  touchIdStatus(): Promise<TouchIdStatus> {
    return this.inner.touchIdStatus();
  }
  requireContentAccess(): void {
    this.inner.requireContentAccess();
  }
  unlock(password: string): Promise<AppUnlockResult> {
    return this.inner.unlock(password);
  }
  authorize(password: string): Promise<AppAuthorizationResult> {
    return this.inner.authorize(password);
  }
  unlockWithTouchId(): Promise<AppTouchIdUnlockResult> {
    return this.inner.unlockWithTouchId();
  }
  enableTouchId(password: string): Promise<TouchIdEnableResult> {
    return this.inner.enableTouchId(password);
  }
  disableTouchId(): Promise<boolean> {
    return this.inner.disableTouchId();
  }
  lock(): Promise<void> {
    return this.inner.lock();
  }
  configure(input: ConfigureAppLockInput): Promise<void> {
    return this.inner.configure(input);
  }
  changePassword(currentPassword: string, nextPassword: string): Promise<AppSettingsMutationResult> {
    return this.inner.changePassword(currentPassword, nextPassword);
  }
  anchorPolicy(): 'usability' | 'hardened' {
    return this.inner.anchorPolicy?.() ?? 'usability';
  }
  setAnchorPolicy(password: string, policy: 'usability' | 'hardened'): Promise<AppSettingsMutationResult> {
    return this.inner.setAnchorPolicy?.(password, policy) ?? Promise.resolve({ ok: false, reason: null });
  }
  remove(password: string): Promise<AppSettingsMutationResult> {
    return this.inner.remove(password);
  }
  recover(input: ConfigureAppLockInput): Promise<void> {
    return this.inner.recover(input);
  }
}
