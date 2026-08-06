import { randomBytes } from 'node:crypto';

import { startGoogleDriveLoopbackCapture } from './loopback.js';
import { buildGoogleDriveAuthorizeUrl, createPkce, exchangeGoogleDriveCode, redactGoogleCredentials } from './oauth.js';
import type { GoogleDriveAuthClient } from './auth-client.js';
import type { GoogleDriveTokenStore } from './token-store.js';
import type { ProviderConnectResult } from '../../../shared/backup/provider-descriptor.js';

export type GoogleDriveConnectResult = ProviderConnectResult;

export function createGoogleDriveConnect(options: {
  readonly clientId: () => string | null;
  readonly clientSecret?: (() => string | null) | undefined;
  readonly tokenStore: GoogleDriveTokenStore;
  readonly authClient: GoogleDriveAuthClient;
  readonly openExternal: (url: string) => Promise<void>;
  readonly onConnected: () => void;
  readonly fetchImpl?: typeof fetch;
  readonly port?: number;
  readonly timeoutMs?: number;
}): () => Promise<GoogleDriveConnectResult> {
  let inFlight = false;
  return async () => {
    if (inFlight) {
      return { ok: false, reason: 'A Google Drive sign-in is already in progress — finish it in the browser.' };
    }
    const clientId = options.clientId();
    if (clientId === null) {
      return { ok: false, reason: 'Google Drive is not configured in this build.' };
    }
    inFlight = true;
    const state = randomBytes(16).toString('hex');
    const pkce = createPkce();
    const capture = startGoogleDriveLoopbackCapture({
      state,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    try {
      const { redirectUri } = await capture.listening;
      await options.openExternal(buildGoogleDriveAuthorizeUrl({ clientId, redirectUri, state, challenge: pkce.challenge }));
      const { code } = await capture.result;
      const tokens = await exchangeGoogleDriveCode({
        clientId,
        clientSecret: options.clientSecret?.() ?? null,
        code,
        verifier: pkce.verifier,
        redirectUri,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      options.tokenStore.save({ clientId, refreshToken: tokens.refreshToken, connectedAt: new Date().toISOString() });
      options.authClient.seed(tokens.accessToken, tokens.expiresIn);
      options.onConnected();
      return { ok: true, reason: null };
    } catch (error) {
      capture.close();
      return {
        ok: false,
        reason: redactGoogleCredentials(error instanceof Error ? error.message : 'Google Drive sign-in failed.'),
      };
    } finally {
      inFlight = false;
    }
  };
}
