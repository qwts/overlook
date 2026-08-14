import { ProviderError, raceWithAbort, type ProviderAuthState } from '../provider.js';
import { googleOAuthFailureReason, redactGoogleCredentials } from './oauth.js';
import type { GoogleDriveTokenStore } from './token-store.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface RefreshResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly error?: unknown;
  readonly error_description?: unknown;
}

/** Late-bound access tokens backed by one sealed refresh token. Access
 * tokens stay in memory and concurrent callers share one refresh. */
export class GoogleDriveAuthClient {
  private cached: { token: string; expiresAt: number } | null = null;
  private refreshInFlight: Promise<string> | null = null;
  private refreshController: AbortController | null = null;
  private refreshWaiters = 0;

  constructor(
    private readonly options: {
      readonly clientId: () => string | null;
      readonly clientSecret?: (() => string | null) | undefined;
      readonly tokenStore: GoogleDriveTokenStore;
      readonly fetchImpl?: typeof fetch;
      readonly now?: () => number;
    },
  ) {}

  authState(): ProviderAuthState {
    const clientId = this.options.clientId();
    const record = this.options.tokenStore.load();
    return clientId !== null && record?.clientId === clientId ? 'connected' : 'not-connected';
  }

  seed(accessToken: string, expiresIn: number): void {
    this.cached = { token: accessToken, expiresAt: this.now() + expiresIn * 1000 };
  }

  invalidate(): void {
    this.cached = null;
  }

  clear(): void {
    this.invalidate();
    this.options.tokenStore.clear();
  }

  accessToken(forceRefresh = false, signal?: AbortSignal): Promise<string> {
    if (!forceRefresh && this.cached !== null && this.cached.expiresAt - this.now() > 60_000) {
      return Promise.resolve(this.cached.token);
    }
    this.cached = null;
    let pending = this.refreshInFlight;
    let controller = this.refreshController;
    if (pending === null || controller === null) {
      controller = new AbortController();
      const refresh = this.refresh(controller.signal).finally(() => {
        if (this.refreshInFlight === refresh) {
          this.refreshInFlight = null;
          this.refreshController = null;
          this.refreshWaiters = 0;
        }
      });
      pending = refresh;
      this.refreshInFlight = refresh;
      this.refreshController = controller;
    }
    this.refreshWaiters += 1;
    const activeController = controller;
    const activePending = pending;
    let released = false;
    const release = (cancel: boolean, reason?: unknown): void => {
      if (released) return;
      released = true;
      if (this.refreshInFlight === activePending) {
        this.refreshWaiters -= 1;
      }
      if (cancel && this.refreshInFlight === activePending && this.refreshWaiters === 0) {
        this.refreshInFlight = null;
        this.refreshController = null;
        activeController.abort(reason);
      }
    };
    if (signal === undefined) return activePending.finally(() => release(false));
    const cancelRefresh = (): void => release(true, signal.reason);
    if (signal.aborted) cancelRefresh();
    else signal.addEventListener('abort', cancelRefresh, { once: true });
    return raceWithAbort(activePending, signal).finally(() => {
      signal.removeEventListener('abort', cancelRefresh);
      release(false);
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async refresh(signal: AbortSignal): Promise<string> {
    const clientId = this.options.clientId();
    const record = this.options.tokenStore.load();
    if (clientId === null || record === null || record.clientId !== clientId) {
      throw new ProviderError('Google Drive is not connected', 'auth');
    }
    let response: Response;
    const body = new URLSearchParams({ client_id: clientId, refresh_token: record.refreshToken, grant_type: 'refresh_token' });
    const clientSecret = this.options.clientSecret?.()?.trim() ?? '';
    if (clientSecret !== '') body.set('client_secret', clientSecret);
    try {
      response = await (this.options.fetchImpl ?? fetch)(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'network failure';
      throw new ProviderError(redactGoogleCredentials(`Google Drive token refresh failed: ${detail}`), 'transient');
    }
    const data = (await response.json().catch(() => ({}))) as RefreshResponse;
    if (!response.ok) {
      const reason = googleOAuthFailureReason(data, response.status);
      const kind = response.status === 400 || response.status === 401 ? 'auth' : 'transient';
      throw new ProviderError(redactGoogleCredentials(`Google Drive token refresh failed: ${reason}`), kind);
    }
    if (typeof data.access_token !== 'string' || data.access_token === '') {
      throw new ProviderError('Google Drive token refresh returned no access token', 'transient');
    }
    const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
    this.cached = { token: data.access_token, expiresAt: this.now() + expiresIn * 1000 };
    return data.access_token;
  }
}
