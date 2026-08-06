import type { CustodyAuthorityRepository } from './custody-authority-repository.js';
import type { LibraryEntry } from '../../shared/library/registry.js';

export interface CustodyCredential {
  readonly providerId: string;
  readonly accountId: string;
}

export interface CustodyRiskLibrary {
  readonly libraryId: string;
  readonly name: string;
  readonly items: number;
  readonly bytes: number;
  readonly legacyUnbound: boolean;
}

export interface CustodyPreflight {
  readonly credential: CustodyCredential;
  readonly totalItems: number;
  readonly totalBytes: number;
  readonly libraries: readonly CustodyRiskLibrary[];
}

export interface CustodyGateDependencies {
  readonly authorities: Pick<CustodyAuthorityRepository, 'soleCustodyCounts' | 'legacyUnboundCount'>;
  readonly activeLibrary: () => Pick<LibraryEntry, 'id' | 'name'>;
  readonly libraries: () => readonly LibraryEntry[];
}

/** Profile-wide disconnect/switch preflight. Open-library database truth and
 * sealed-library conservative hints form one at-risk union (ADR-0028 §4). */
export class CustodyGate {
  constructor(private readonly deps: CustodyGateDependencies) {}

  preflight(credential: CustodyCredential): CustodyPreflight {
    const active = this.deps.activeLibrary();
    const libraries: CustodyRiskLibrary[] = [];
    const bound = this.deps.authorities
      .soleCustodyCounts()
      .filter(({ authority }) => authority.providerId === credential.providerId && authority.accountId === credential.accountId)
      .reduce((total, count) => ({ items: total.items + count.items, bytes: total.bytes + count.bytes }), { items: 0, bytes: 0 });
    const legacy = this.deps.authorities.legacyUnboundCount();
    if (bound.items > 0 || legacy.items > 0) {
      libraries.push({
        libraryId: active.id,
        name: active.name,
        items: bound.items + legacy.items,
        bytes: bound.bytes + legacy.bytes,
        legacyUnbound: legacy.items > 0,
      });
    }

    for (const library of this.deps.libraries()) {
      if (library.id === active.id) continue;
      const stake = (library.custodyHints ?? [])
        .filter((hint) => hint.providerId === credential.providerId && hint.accountId === credential.accountId)
        .reduce(
          (total, hint) => ({
            items: total.items + hint.soleCustodyItems,
            bytes: total.bytes + hint.soleCustodyBytes,
          }),
          { items: 0, bytes: 0 },
        );
      if (stake.items > 0) {
        libraries.push({
          libraryId: library.id,
          name: library.name,
          items: stake.items,
          bytes: stake.bytes,
          legacyUnbound: false,
        });
      }
    }

    return {
      credential,
      totalItems: libraries.reduce((total, library) => total + library.items, 0),
      totalBytes: libraries.reduce((total, library) => total + library.bytes, 0),
      libraries,
    };
  }
}
