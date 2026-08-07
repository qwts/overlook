import path from 'node:path';

import { createBackupAuditLogger } from './backup-audit.js';
import { createManifestDebtStore } from './manifest-debt.js';
import { guardProviderSwitch } from './provider-switch-guard.js';
import type { ProviderRuntimeOptions } from './provider-runtime.js';
import { SyncLedger } from './sync-ledger.js';
import { providerSwitchClaims } from '../db/backup-claims.js';
import type { ProtectedRuntime } from '../library/protected-runtime.js';
import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// Composition seam for the #741 provider-switch guard, kept out of index.ts
// (file-size budget). The guard resolves the open library's parts lazily so
// runtime construction never bootstraps a library. Structurally typed so
// LibraryParts satisfies it while tests supply narrow fakes.

export interface ProviderSwitchGuardParts {
  readonly db: BetterSqlite3.Database;
  readonly blobStore: { hasOriginal(contentHash: string): boolean };
  readonly protected: Pick<ProtectedRuntime, 'switchGuardBinding'>;
}

export interface ProviderSwitchBindingDeps {
  /** The ALREADY-OPEN library's parts, or null when none is open. The guard
   * must never bootstrap a library: materializing one during a fresh-profile
   * onboarding connect would make the restore target non-empty and fail the
   * later destructive-authorization check (PR #743 review). */
  readonly parts: () => ProviderSwitchGuardParts | null;
  readonly libraryDataDir: () => string;
}

export function createProviderSwitchGuard(deps: ProviderSwitchBindingDeps): NonNullable<ProviderRuntimeOptions['switchGuard']> {
  return async (target) => {
    const parts = deps.parts();
    if (parts === null) {
      // No open library → no claims to protect; restore/onboarding flows
      // connect providers freely and validate through their own engines.
      return { ok: true, reason: null };
    }
    const ledger = new SyncLedger(parts.db);
    const protectedGuard = parts.protected.switchGuardBinding();
    const audit = createBackupAuditLogger(path.join(deps.libraryDataDir(), 'backup-audit.log'));
    return guardProviderSwitch({
      target,
      ordinaryClaims: () => providerSwitchClaims(parts.db),
      protectedClaims: protectedGuard.claims,
      hasLocalOriginal: (hash) => parts.blobStore.hasOriginal(hash),
      hasLocalProtected: protectedGuard.hasLocal,
      ledger: {
        isDirty: (photoId) => ledger.isDirty(photoId),
        markDirty: (photoId) => ledger.markDirty(photoId),
        repairStatus: (photoId, to) => ledger.repairStatus(photoId, to),
      },
      requeueProtected: protectedGuard.requeue,
      healProtected: protectedGuard.heal,
      markManifestOwed: () => createManifestDebtStore(parts.db).save(true),
      audit,
    });
  };
}
