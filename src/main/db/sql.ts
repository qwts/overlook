import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

// better-sqlite3's statement results are typed `any`; these helpers are the
// single place that boundary is crossed (caller declares the row shape), so
// the `any` never leaks into repository or test code.

// Prepared statements are cached per connection: re-preparing on every call
// made SQLite re-parse and re-codegen the same SQL text, ~25% of profiled
// CPU during the 113K-import backup sweep. SQLite recompiles a cached
// statement itself if the schema changes, and the WeakMap lets a closed
// connection's cache be collected with it. LRU-capped so unbounded dynamic
// SQL cannot grow the cache without limit.
const STATEMENT_CACHE_MAX = 100;
const statementCaches = new WeakMap<BetterSqlite3.Database, Map<string, BetterSqlite3.Statement>>();

function prepared(db: BetterSqlite3.Database, sql: string): BetterSqlite3.Statement {
  let cache = statementCaches.get(db);
  if (cache === undefined) {
    cache = new Map();
    statementCaches.set(db, cache);
  }
  const hit = cache.get(sql);
  if (hit !== undefined) {
    // Map iteration order is insertion order — re-inserting marks recency.
    cache.delete(sql);
    cache.set(sql, hit);
    return hit;
  }
  const statement = db.prepare(sql);
  cache.set(sql, statement);
  if (cache.size > STATEMENT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  return statement;
}

export function queryAll<T>(db: BetterSqlite3.Database, sql: string, params?: Record<string, unknown>): T[] {
  const statement = prepared(db, sql);
  // type-coverage:ignore-next-line -- the driver types rows as any
  return (params === undefined ? statement.all() : statement.all(params)) as T[];
}

export function queryGet<T>(db: BetterSqlite3.Database, sql: string, ...params: readonly unknown[]): T | undefined {
  const statement = prepared(db, sql);
  // type-coverage:ignore-next-line -- the driver types rows as any
  return statement.get(...params) as T | undefined;
}

export function run(db: BetterSqlite3.Database, sql: string, ...params: readonly unknown[]): void {
  prepared(db, sql).run(...params);
}

export function runNamed(db: BetterSqlite3.Database, sql: string, params: Record<string, unknown>): void {
  prepared(db, sql).run(params);
}
