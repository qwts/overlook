import { randomBytes } from 'node:crypto';

import { startLoopbackCapture } from './loopback.js';
import { buildAuthorizeUrl, redactTokens } from './oauth.js';
import type { PCloudTokenStore } from './token-store.js';
import type { ProviderConnectResult } from '../../../shared/backup/provider-descriptor.js';

// The pCloud handshake (#254), composed from the loopback + custody pieces.
// The browser launcher and the connected-side-effect are injected so the
// whole flow runs under node:test with a scripted "browser".

export interface PCloudConnectOptions {
  readonly tokenStore: PCloudTokenStore;
  readonly clientId: string;
  /** Production: shell.openExternal. */
  readonly openExternal: (url: string) => Promise<void>;
  /** Called only after the token is sealed. Selection no longer flips here:
   * the runtime activates (guarded, #741) after the flow returns, so a
   * refused switch keeps the credential without moving settings.providerId. */
  readonly onConnected: () => void;
  /** Test seams; production uses the registered port and a 5-min timeout. */
  readonly port?: number;
  readonly timeoutMs?: number;
}

export type PCloudConnectResult = ProviderConnectResult;

export function createPCloudConnect(options: PCloudConnectOptions): () => Promise<PCloudConnectResult> {
  // One flow at a time — a second Connect while the browser tab is open
  // must not spawn a second listener on the same port.
  let inFlight = false;

  return async () => {
    if (inFlight) {
      return { ok: false, reason: 'A pCloud sign-in is already in progress — finish it in the browser.' };
    }
    inFlight = true;
    const state = randomBytes(16).toString('hex');
    const capture = startLoopbackCapture({
      state,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    try {
      await capture.listening;
      await options.openExternal(buildAuthorizeUrl(state, options.clientId));
      const result = await capture.result;
      options.tokenStore.save({ ...result, connectedAt: new Date().toISOString() });
      options.onConnected();
      return { ok: true, reason: null };
    } catch (error) {
      capture.close();
      return { ok: false, reason: redactTokens(error instanceof Error ? error.message : 'pCloud sign-in failed.') };
    } finally {
      inFlight = false;
    }
  };
}
