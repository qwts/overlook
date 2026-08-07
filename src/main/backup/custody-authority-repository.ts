import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, run, runNamed } from '../db/sql.js';

export type CustodyAuthorityState = 'bound' | 'provider-required';

export interface CustodyAuthority {
  readonly id: number;
  readonly providerId: string;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly remoteRoot: string;
  readonly state: CustodyAuthorityState;
  readonly createdAt: string;
  readonly lastVerifiedAt: string | null;
}

export interface NewCustodyAuthority {
  readonly providerId: string;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly remoteRoot: string;
  readonly createdAt: string;
  readonly lastVerifiedAt?: string | null | undefined;
}

export interface SoleCustodyCount {
  readonly authority: CustodyAuthority;
  readonly items: number;
  readonly bytes: number;
}

function fromRow(row: {
  id: number;
  providerId: string;
  accountId: string;
  accountLabel: string;
  remoteRoot: string;
  state: CustodyAuthorityState;
  createdAt: string;
  lastVerifiedAt: string | null;
}): CustodyAuthority {
  return {
    id: row.id,
    providerId: row.providerId,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    remoteRoot: row.remoteRoot,
    state: row.state,
    createdAt: row.createdAt,
    lastVerifiedAt: row.lastVerifiedAt,
  };
}

/** Library-scoped non-secret source-custody records (ADR-0028 §1). */
export class CustodyAuthorityRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  create(input: NewCustodyAuthority): CustodyAuthority {
    const existing = this.find(input.providerId, input.accountId, input.remoteRoot);
    if (existing !== undefined) return existing;
    runNamed(
      this.db,
      `INSERT INTO custody_authorities (
         provider_id, account_id, account_label, remote_root, state, created_at, last_verified_at
       ) VALUES (
         @providerId, @accountId, @accountLabel, @remoteRoot, 'bound', @createdAt, @lastVerifiedAt
       )`,
      { ...input, lastVerifiedAt: input.lastVerifiedAt ?? null },
    );
    const created = this.find(input.providerId, input.accountId, input.remoteRoot);
    if (created === undefined) throw new Error('custody authority did not persist');
    return created;
  }

  get(id: number): CustodyAuthority | undefined {
    const row = queryGet<{
      id: number;
      providerId: string;
      accountId: string;
      accountLabel: string;
      remoteRoot: string;
      state: CustodyAuthorityState;
      createdAt: string;
      lastVerifiedAt: string | null;
    }>(
      this.db,
      `SELECT id, provider_id AS providerId, account_id AS accountId, account_label AS accountLabel,
              remote_root AS remoteRoot, state, created_at AS createdAt, last_verified_at AS lastVerifiedAt
         FROM custody_authorities WHERE id = ?`,
      id,
    );
    return row === undefined ? undefined : fromRow(row);
  }

  /** Resolves sole-remote work through the row's durable provenance, never
   * through the provider currently selected for new backups. */
  forPhoto(photoId: string): CustodyAuthority | undefined {
    const row = queryGet<{
      id: number;
      providerId: string;
      accountId: string;
      accountLabel: string;
      remoteRoot: string;
      state: CustodyAuthorityState;
      createdAt: string;
      lastVerifiedAt: string | null;
    }>(
      this.db,
      `SELECT a.id, a.provider_id AS providerId, a.account_id AS accountId, a.account_label AS accountLabel,
              a.remote_root AS remoteRoot, a.state, a.created_at AS createdAt, a.last_verified_at AS lastVerifiedAt
         FROM sync_ledger l
         JOIN custody_authorities a ON a.id = l.custody_authority_id
        WHERE l.photo_id = ?`,
      photoId,
    );
    return row === undefined ? undefined : fromRow(row);
  }

  find(providerId: string, accountId: string, remoteRoot: string): CustodyAuthority | undefined {
    const row = queryGet<{
      id: number;
      providerId: string;
      accountId: string;
      accountLabel: string;
      remoteRoot: string;
      state: CustodyAuthorityState;
      createdAt: string;
      lastVerifiedAt: string | null;
    }>(
      this.db,
      `SELECT id, provider_id AS providerId, account_id AS accountId, account_label AS accountLabel,
              remote_root AS remoteRoot, state, created_at AS createdAt, last_verified_at AS lastVerifiedAt
         FROM custody_authorities
        WHERE provider_id = ? AND account_id = ? AND remote_root = ?`,
      providerId,
      accountId,
      remoteRoot,
    );
    return row === undefined ? undefined : fromRow(row);
  }

  /** Exact per-authority preflight counts. Error rows retain their binding. */
  soleCustodyCounts(): readonly SoleCustodyCount[] {
    return queryAll<{
      id: number;
      providerId: string;
      accountId: string;
      accountLabel: string;
      remoteRoot: string;
      state: CustodyAuthorityState;
      createdAt: string;
      lastVerifiedAt: string | null;
      items: number;
      bytes: number;
    }>(
      this.db,
      `SELECT a.id, a.provider_id AS providerId, a.account_id AS accountId, a.account_label AS accountLabel,
              a.remote_root AS remoteRoot, a.state, a.created_at AS createdAt, a.last_verified_at AS lastVerifiedAt,
              count(l.photo_id) AS items, coalesce(sum(p.bytes), 0) AS bytes
         FROM custody_authorities a
         JOIN sync_ledger l ON l.custody_authority_id = a.id
         JOIN photos p ON p.id = l.photo_id
        WHERE l.status IN ('offloaded', 'error')
        GROUP BY a.id
        ORDER BY a.id`,
    ).map((row) => ({ authority: fromRow(row), items: row.items, bytes: row.bytes }));
  }

  /** Authorities with offloaded rows, used to partition integrity work and
   * its resume cursor by durable source rather than current selection. */
  offloadedAuthorities(): readonly CustodyAuthority[] {
    return queryAll<{
      id: number;
      providerId: string;
      accountId: string;
      accountLabel: string;
      remoteRoot: string;
      state: CustodyAuthorityState;
      createdAt: string;
      lastVerifiedAt: string | null;
    }>(
      this.db,
      `SELECT DISTINCT a.id, a.provider_id AS providerId, a.account_id AS accountId,
              a.account_label AS accountLabel, a.remote_root AS remoteRoot, a.state,
              a.created_at AS createdAt, a.last_verified_at AS lastVerifiedAt
         FROM custody_authorities a
         JOIN sync_ledger l ON l.custody_authority_id = a.id
        WHERE l.status = 'offloaded'
        ORDER BY a.id`,
    ).map(fromRow);
  }

  /** Legacy rows are intentionally separate: no connected account earns them
   * a binding without ADR-0028 §7 verification. */
  legacyUnboundCount(): { readonly items: number; readonly bytes: number } {
    return (
      queryGet<{ items: number; bytes: number }>(
        this.db,
        `SELECT count(*) AS items, coalesce(sum(p.bytes), 0) AS bytes
           FROM sync_ledger l JOIN photos p ON p.id = l.photo_id
          WHERE l.custody_authority_id IS NULL
            AND (l.status = 'offloaded' OR (l.status = 'error' AND l.dirty = 0))`,
      ) ?? { items: 0, bytes: 0 }
    );
  }

  /** Reconnect starts by closing the bound-but-disconnected race: every
   * dependent authority for this provider becomes unavailable until the
   * exact account and namespace have been proven again. */
  stageReconnectVerification(providerId: string): readonly CustodyAuthority[] {
    const candidates = this.soleCustodyCounts()
      .map(({ authority }) => authority)
      .filter((authority) => authority.providerId === providerId);
    if (candidates.length === 0) return [];
    run(
      this.db,
      `UPDATE custody_authorities
          SET state = 'provider-required'
        WHERE provider_id = ?
          AND id IN (
            SELECT custody_authority_id FROM sync_ledger
             WHERE custody_authority_id IS NOT NULL AND status IN ('offloaded', 'error')
          )`,
      providerId,
    );
    return candidates.map((authority) => ({ ...authority, state: 'provider-required' }));
  }

  /** Completes only the authorities proven by this verification attempt.
   * Ledger rows never change state during reconnect. */
  markVerified(authorityIds: readonly number[], verifiedAt: string): void {
    this.db.transaction(() => {
      for (const id of authorityIds) {
        run(
          this.db,
          `UPDATE custody_authorities
              SET state = 'bound', last_verified_at = ?
            WHERE id = ?`,
          verifiedAt,
          id,
        );
      }
    })();
  }

  verified(providerId: string, accountId: string, remoteRoot: string): CustodyAuthority | undefined {
    const authority = this.find(providerId, accountId, remoteRoot);
    return authority?.state === 'bound' && authority.lastVerifiedAt !== null ? authority : undefined;
  }

  /** A legacy row earns provenance only after its own remote object proves
   * out. The status predicate prevents a stale scrub item from rebinding a
   * row that another operation already restored or changed. */
  bindLegacyPhoto(photoId: string, custodyAuthorityId: number): boolean {
    if (this.forPhoto(photoId) !== undefined) return false;
    run(
      this.db,
      `UPDATE sync_ledger
          SET custody_authority_id = ?, status = 'offloaded'
        WHERE photo_id = ? AND custody_authority_id IS NULL
          AND (status = 'offloaded' OR (status = 'error' AND dirty = 0))
          AND EXISTS (
            SELECT 1 FROM custody_authorities
             WHERE id = ? AND state = 'bound' AND last_verified_at IS NOT NULL
          )`,
      custodyAuthorityId,
      photoId,
      custodyAuthorityId,
    );
    return this.forPhoto(photoId)?.id === custodyAuthorityId;
  }

  /** Emergency authorization removal preserves every binding field and row;
   * only the derived authority state changes (ADR-0028 §5). */
  markProviderRequired(providerId: string, accountId: string): readonly number[] {
    const affected = this.soleCustodyCounts().filter(
      ({ authority }) => authority.providerId === providerId && authority.accountId === accountId && authority.state === 'bound',
    );
    if (affected.length === 0) return [];
    run(
      this.db,
      `UPDATE custody_authorities
          SET state = 'provider-required'
        WHERE provider_id = ? AND account_id = ?
          AND state = 'bound'
          AND id IN (
            SELECT custody_authority_id FROM sync_ledger
             WHERE custody_authority_id IS NOT NULL AND status IN ('offloaded', 'error')
          )`,
      providerId,
      accountId,
    );
    return affected.map(({ authority }) => authority.id);
  }

  /** Rollback for a failed emergency removal. Only rows transitioned by that
   * attempt are restored; older provider-required state remains untouched. */
  restoreBound(authorityIds: readonly number[]): void {
    this.db.transaction(() => {
      for (const id of authorityIds) {
        run(this.db, `UPDATE custody_authorities SET state = 'bound' WHERE id = ? AND state = 'provider-required'`, id);
      }
    })();
  }

  providerRequirements(): readonly SoleCustodyCount[] {
    return this.soleCustodyCounts().filter(({ authority }) => authority.state === 'provider-required');
  }

  /** Ordinary disconnect removes only authority metadata that no ledger row
   * references. Remote objects and referenced provenance are untouched. */
  deleteUnreferenced(providerId: string, accountId: string): void {
    run(
      this.db,
      `DELETE FROM custody_authorities
        WHERE provider_id = ? AND account_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM sync_ledger l WHERE l.custody_authority_id = custody_authorities.id
          )`,
      providerId,
      accountId,
    );
  }
}
