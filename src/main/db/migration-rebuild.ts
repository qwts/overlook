import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

import type { Migration } from './migrations.js';

// Table-rebuild migrations (#496 was the first) DROP and recreate a parent
// table. With foreign keys on, the DROP cascades every child row away, so
// the guard switches them off around the transaction — the pragma is a
// no-op inside one — runs SQLite's own check before commit, and restores
// the prior state whatever happens. Ordinary migrations run untouched.
export function runMigrationTransaction(
  db: BetterSqlite3.Database,
  migration: Pick<Migration, 'version' | 'rebuild'>,
  body: () => void,
): void {
  const rebuild = migration.rebuild === true;
  const foreignKeysBefore = rebuild ? Boolean(db.pragma('foreign_keys', { simple: true })) : null;
  if (rebuild) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      body();
      if (rebuild) {
        const violations = db.pragma('foreign_key_check') as readonly unknown[];
        if (violations.length > 0) {
          throw new Error(`migration ${String(migration.version)} left ${String(violations.length)} foreign key violation(s)`);
        }
      }
    })();
  } finally {
    if (foreignKeysBefore === true) db.pragma('foreign_keys = ON');
  }
}
