/* eslint-disable @typescript-eslint/unbound-method -- providerFor/getStream are called on their receiver; extraction is intentional and safe */
import type { AppAuthorizationResult, AppLockState } from '../crypto/app-lock-controller.js';
import type { RestoreError } from './restore-types.js';
import type { RestoreCoordinator } from './restore-coordinator.js';

export interface RestoreFacadeOptions {
  readonly coordinator: () => RestoreCoordinator;
  readonly fresh: () => boolean;
  readonly pickKey: () => Promise<string | null>;
  readonly busy: () => boolean;
  readonly lockState: () => AppLockState;
  readonly authorizePassword: (password: string) => Promise<AppAuthorizationResult>;
}

type DiscoverKey = { keyPath: string; password: string } | { localKey: true; password?: string | undefined };

type GateError = { reason: RestoreError['reason']; message: string };

type LocalKeyGate = { readonly refused: GateError } | { readonly custodyPassword?: string };

function truncate(message: string, max = 200): string {
  return message.length > max ? `${message.slice(0, max - 3)}...` : message;
}

function recordRestoreDiagnostic(
  kind: 'restore-verify-failed' | 'restore-failed',
  reason: string,
  message: string,
  extra: { missingCount?: number; corruptCount?: number; phase?: string } = {},
): void {
  try {
    // Dynamic import via require to avoid circular startup ordering; tests stub this.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDiagnosticsService } = require('../diagnostics/diagnostics-runtime.js') as {
      getDiagnosticsService: () => { record: (o: unknown) => boolean };
    };
    const svc = getDiagnosticsService();
    svc.record({
      kind,
      failureReason: reason as never,
      messagePreview: truncate(message),
      phase: (extra.phase as never) ?? 'verify-scan',
      ...(extra.missingCount === undefined ? {} : { missingCount: extra.missingCount }),
      ...(extra.corruptCount === undefined ? {} : { corruptCount: extra.corruptCount }),
    });
  } catch {
    // Diagnostics unavailable (e.g. unit tests without Electron) — best-effort only.
  }
}

/** #754: releasing the keystore-resident master key to restore discovery is
 * destructive-class authority (it can replace the active library). When an
 * app lock is configured, demand the app password at use time — the same
 * fresh-authority ceremony as protected-Original deletion (ADR-0023). The
 * renderer's password field is convenience; this gate is the contract.
 * The custody decision is made HERE, atomically with authorization (PR #757
 * review): re-reading lock state later could drop a verified password if the
 * app locks in between. */
async function authorizeLocalKey(options: RestoreFacadeOptions, password: string | undefined): Promise<LocalKeyGate> {
  const state = options.lockState();
  if (state === 'unconfigured-unlocked') return {};
  if (state !== 'unlocked') {
    return { refused: { reason: 'destructive-authorization', message: "Unlock the app before restoring with this Mac's key." } };
  }
  if (password === undefined || password === '') {
    return { refused: { reason: 'destructive-authorization', message: "Enter your app password to restore with this Mac's key." } };
  }
  const result = await options.authorizePassword(password);
  if (result.ok) return { custodyPassword: password };
  if (result.reason === 'throttled') {
    const seconds = Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1000));
    return { refused: { reason: 'destructive-authorization', message: `Too many password attempts. Try again in ${String(seconds)}s.` } };
  }
  if (result.reason === 'wrong-password') {
    return { refused: { reason: 'destructive-authorization', message: 'That app password is incorrect.' } };
  }
  return { refused: { reason: 'destructive-authorization', message: 'App lock recovery is required before this key can be used.' } };
}

export function createRestoreFacade(options: RestoreFacadeOptions) {
  return {
    profileStatus: () => ({ fresh: options.fresh() }),
    pickKey: options.pickKey,
    discover: async (providerId: string, key: DiscoverKey) => {
      if ('keyPath' in key) {
        return options.coordinator().discoverFrom(providerId, { kind: 'recovery-key', path: key.keyPath, password: key.password });
      }
      const gate = await authorizeLocalKey(options, key.password);
      if ('refused' in gate) {
        // A refusal must not leave an earlier discovery's master key
        // runnable (PR #757 review) — discovery normally expires the prior
        // session, so the refused path has to as well.
        options.coordinator().expireSession();
        return { sessionId: null, libraries: [], error: gate.refused };
      }
      // The password reaches the coordinator only after authorizePassword
      // verified it; the engine reuses it to re-establish password-derived
      // custody for the restored library (#754's second half).
      return options.coordinator().discoverFrom(providerId, {
        kind: 'local-master',
        ...(gate.custodyPassword === undefined ? {} : { custodyPassword: gate.custodyPassword }),
      });
    },
    run: async (sessionId: string, libraryId: string, allowReplace: boolean) => {
      if (options.busy()) {
        return {
          result: null,
          error: { reason: 'io' as const, message: 'Wait for the active backup or restore to finish.' },
        };
      }
      const response = await options.coordinator().run(sessionId, libraryId, allowReplace);
      if (response.error !== null) {
        const r = response.error.reason;
        if (r === 'corrupt' || r === 'offline' || r === 'disk-space' || r === 'unsupported' || r === 'io') {
          recordRestoreDiagnostic('restore-failed', r, response.error.message, { phase: 'downloading' });
        }
      }
      return response;
    },
    verify: async (sessionId: string, libraryId: string) => {
      if (options.busy()) {
        return {
          result: null,
          error: { reason: 'io' as const, message: 'Wait for the active backup or restore to finish.' },
        };
      }
      const response = await options.coordinator().verify(sessionId, libraryId);
      if (response.error !== null) {
        const r = response.error.reason;
        if (r === 'corrupt' || r === 'offline' || r === 'disk-space' || r === 'unsupported' || r === 'io') {
          recordRestoreDiagnostic('restore-verify-failed', r, response.error.message, { phase: 'verify-scan' });
        }
      } else if (response.result !== null && (response.result.missingCount > 0 || response.result.corruptCount > 0)) {
        // Gap discovered — also record for discoverability even though not an error.
        // Only if diagnostics consented; the service itself checks consent.
        // We record as verify-failed with corrupt/offline-like reason so Review reports surfaces.
        // For clean gaps (not-found), do not spam diagnostics — inline UI is enough.
        if (response.result.corruptCount > 0) {
          recordRestoreDiagnostic(
            'restore-verify-failed',
            'corrupt',
            `${String(response.result.missingCount)} missing, ${String(response.result.corruptCount)} corrupt`,
            {
              missingCount: response.result.missingCount,
              corruptCount: response.result.corruptCount,
              phase: 'verify-scan',
            },
          );
        }
      }
      return response;
    },
    trash: (sessionId: string, libraryId: string, confirmation: string) => {
      if (confirmation !== 'Permanently Delete Backup') {
        return Promise.resolve({ trashed: false, error: { reason: 'io' as const, message: 'Confirmation text does not match.' } });
      }
      return options.coordinator().trash(sessionId, libraryId, confirmation);
    },
    exportCsv: async (sessionId: string, libraryId: string) => {
      const verify = await options.coordinator().verify(sessionId, libraryId);
      if (verify.error !== null || verify.result === null) {
        return { exported: false, path: null, error: verify.error?.message ?? 'Verify failed' };
      }
      const { dialog } = await import('electron');
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: `restore-missing-${libraryId}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (canceled || !filePath) return { exported: false, path: null, error: null };
      const { writeFile } = await import('node:fs/promises');
      const header = 'path,kind,photoId,reason\n';
      const rows = verify.result.missing.map((o) => `${JSON.stringify(o.path)},${o.kind},${o.photoId ?? ''},${o.reason}`).join('\n');
      await writeFile(filePath, header + rows, 'utf8');
      return { exported: true, path: filePath, error: null };
    },
    exportCorrupt: async (sessionId: string, libraryId: string) => {
      const verify = await options.coordinator().verify(sessionId, libraryId);
      if (verify.error !== null || verify.result === null) {
        return { exported: false, count: 0, error: verify.error?.message ?? 'Verify failed' };
      }
      const corrupt = verify.result.missing.filter((o) => o.reason === 'failed-verification');
      if (corrupt.length === 0) return { exported: true, count: 0, error: null };
      const { dialog } = await import('electron');
      const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (canceled || filePaths.length === 0 || !filePaths[0]) return { exported: false, count: 0, error: null };
      const destDir = filePaths[0];
      const provider = options.coordinator().providerFor(sessionId, libraryId);
      if (provider === null) return { exported: false, count: 0, error: 'Restore discovery expired; discover the backup again.' };
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { buffer } = await import('node:stream/consumers');
      await mkdir(destDir, { recursive: true });
      let exported = 0;
      for (const entry of corrupt) {
        try {
          const stream = await provider.getStream(entry.path);
          const bytes = await buffer(stream);
          const fileName = entry.path.split(/[\\/]/u).at(-1) ?? `${entry.photoId ?? 'blob'}-${String(exported)}`;
          const safeName = fileName.replace(/[^a-zA-Z0-9._-]/gu, '_');
          await writeFile(join(destDir, safeName), bytes);
          exported += 1;
        } catch {
          // best-effort per blob
        }
      }
      return { exported: true, count: exported, error: null };
    },
    cancel: () => {
      options.coordinator().cancel();
    },
  };
}
