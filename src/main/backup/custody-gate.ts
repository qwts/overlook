import type { CustodyAuthorityRepository } from './custody-authority-repository.js';
import type { LibraryEntry } from '../../shared/library/registry.js';
import type { CustodyCredential, CustodyPreflight, CustodyRiskLibrary } from '../../shared/backup/provider-descriptor.js';

export interface CustodyGateDependencies {
  readonly authorities: Pick<CustodyAuthorityRepository, 'soleCustodyCounts' | 'legacyUnboundCount'>;
  readonly activeLibrary: () => Pick<LibraryEntry, 'id' | 'name'>;
  readonly libraries: () => readonly LibraryEntry[];
}

/** Conservative preflight when a library database is sealed. Hints may
 * overcount, but credential removal must never treat them as zero. */
export function custodyHintPreflight(credential: CustodyCredential, libraries: readonly LibraryEntry[]): CustodyPreflight {
  const risks = libraries.flatMap((library): CustodyRiskLibrary[] => {
    const stake = (library.custodyHints ?? [])
      .filter((hint) => hint.providerId === credential.providerId && hint.accountId === credential.accountId)
      .reduce((total, hint) => ({ items: total.items + hint.soleCustodyItems, bytes: total.bytes + hint.soleCustodyBytes }), {
        items: 0,
        bytes: 0,
      });
    return stake.items === 0
      ? []
      : [{ libraryId: library.id, name: library.name, items: stake.items, bytes: stake.bytes, legacyUnbound: false }];
  });
  return {
    credential,
    totalItems: risks.reduce((total, library) => total + library.items, 0),
    totalBytes: risks.reduce((total, library) => total + library.bytes, 0),
    libraries: risks,
  };
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

    libraries.push(
      ...custodyHintPreflight(
        credential,
        this.deps.libraries().filter((library) => library.id !== active.id),
      ).libraries,
    );

    return {
      credential,
      totalItems: libraries.reduce((total, library) => total + library.items, 0),
      totalBytes: libraries.reduce((total, library) => total + library.bytes, 0),
      libraries,
    };
  }
}

export interface CustodyHintCoordinatorDependencies {
  readonly authorities: Pick<CustodyAuthorityRepository, 'soleCustodyCounts'>;
  readonly write: (hints: NonNullable<LibraryEntry['custodyHints']>) => void;
}

function exactHints(
  counts: ReturnType<CustodyHintCoordinatorDependencies['authorities']['soleCustodyCounts']>,
): NonNullable<LibraryEntry['custodyHints']> {
  const hints = new Map<string, NonNullable<LibraryEntry['custodyHints']>[number]>();
  for (const count of counts) {
    const key = `${count.authority.providerId}\0${count.authority.accountId}`;
    const current = hints.get(key);
    hints.set(key, {
      providerId: count.authority.providerId,
      accountId: count.authority.accountId,
      soleCustodyItems: (current?.soleCustodyItems ?? 0) + count.items,
      soleCustodyBytes: (current?.soleCustodyBytes ?? 0) + count.bytes,
    });
  }
  return [...hints.values()];
}

/** Writes a conservative sealed-library summary before binding and clears
 * overcounts only after an exact database recount. */
export class CustodyHintCoordinator {
  constructor(private readonly deps: CustodyHintCoordinatorDependencies) {}

  beforeBinding(credential: CustodyCredential, bytes: number): void {
    const hints = [...exactHints(this.deps.authorities.soleCustodyCounts())];
    const index = hints.findIndex((hint) => hint.providerId === credential.providerId && hint.accountId === credential.accountId);
    const current = hints[index];
    const prospective = {
      providerId: credential.providerId,
      accountId: credential.accountId,
      soleCustodyItems: (current?.soleCustodyItems ?? 0) + 1,
      soleCustodyBytes: (current?.soleCustodyBytes ?? 0) + bytes,
    };
    if (index === -1) hints.push(prospective);
    else hints[index] = prospective;
    this.deps.write(hints);
  }

  refresh(): void {
    this.deps.write(exactHints(this.deps.authorities.soleCustodyCounts()));
  }
}
