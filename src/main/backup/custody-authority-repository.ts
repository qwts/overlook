import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import { queryAll, queryGet, runNamed } from '../db/sql.js';

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

  /** Legacy rows are intentionally separate: no connected account earns them
   * a binding without ADR-0028 §7 verification. */
  legacyUnboundCount(): { readonly items: number; readonly bytes: number } {
    return (
      queryGet<{ items: number; bytes: number }>(
        this.db,
        `SELECT count(*) AS items, coalesce(sum(p.bytes), 0) AS bytes
           FROM sync_ledger l JOIN photos p ON p.id = l.photo_id
          WHERE l.status = 'offloaded' AND l.custody_authority_id IS NULL`,
      ) ?? { items: 0, bytes: 0 }
    );
  }
}
