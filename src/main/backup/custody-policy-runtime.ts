import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { CustodyCredential, CustodyPreflight, CustodyRequirement } from '../../shared/backup/provider-descriptor.js';
import type { LibraryEntry } from '../../shared/library/registry.js';
import { CustodyAuthorityRepository } from './custody-authority-repository.js';
import { CustodyGate } from './custody-gate.js';

export interface CustodyPolicyRuntimeOptions {
  readonly db: BetterSqlite3.Database;
  readonly activeLibrary: () => Pick<LibraryEntry, 'id' | 'name'>;
  readonly libraries: () => readonly LibraryEntry[];
}

export interface CustodyPolicyRuntime {
  readonly preflight: (credential: CustodyCredential) => CustodyPreflight;
  readonly markProviderRequired: (credential: CustodyCredential) => () => void;
  readonly deleteUnreferenced: (credential: CustodyCredential) => void;
  readonly requirements: () => readonly CustodyRequirement[];
}

export function createCustodyPolicyRuntime(options: CustodyPolicyRuntimeOptions): CustodyPolicyRuntime {
  const authorities = new CustodyAuthorityRepository(options.db);
  const gate = new CustodyGate({ authorities, activeLibrary: options.activeLibrary, libraries: options.libraries });
  return {
    preflight: (credential) => gate.preflight(credential),
    markProviderRequired: (credential) => {
      const changed = authorities.markProviderRequired(credential.providerId, credential.accountId);
      return () => authorities.restoreBound(changed);
    },
    deleteUnreferenced: (credential) => {
      authorities.deleteUnreferenced(credential.providerId, credential.accountId);
    },
    requirements: () =>
      authorities.providerRequirements().map(({ authority, items, bytes }) => ({
        providerId: authority.providerId,
        accountId: authority.accountId,
        accountLabel: authority.accountLabel,
        items,
        bytes,
      })),
  };
}
