import { hostname } from 'node:os';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { machineId } from './machine-id.js';

// Per-library single-instance lock (ADR-0017 §5, #385). Advisory: it orders
// honest actors — two app instances on one machine cannot open the same
// library concurrently. Created O_EXCL; a conflict is examined rather than
// trusted: a same-machine lock whose pid is dead is stale (crash) and
// reclaimed, a same-machine live pid refuses, and a lock from another
// machine (network share) refuses because liveness cannot be verified
// across machines.
//
// Same-machine identity keys on the stable machine id when both the record
// and this process have one (#842): hostnames drift with network state
// (`.local` ↔ `.lan`), which made crashed same-machine locks permanently
// unreclaimable. The hostname stays in the record as the cross-host display
// string and as the conservative fallback for legacy records.

export class LibraryLockError extends Error {
  override readonly name = 'LibraryLockError';
  constructor(
    message: string,
    readonly reason: 'held-by-instance' | 'held-by-other-host',
  ) {
    super(message);
  }
}

export interface LibraryLockRecord {
  readonly instanceId: string;
  readonly pid: number;
  readonly hostname: string;
  /** Stable machine identity (#842); absent in legacy records and when the
   * probe fails, in which case hostname comparison decides. */
  readonly machineId?: string;
  readonly acquiredAt: string;
}

export interface LibraryLockOptions {
  /** Injected for tests. */
  readonly host?: string;
  readonly pid?: number;
  /** Injected for tests: null = machine id unavailable (legacy behavior). */
  readonly machineId?: string | null;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

function resolveMachineId(options: LibraryLockOptions): string | undefined {
  return options.machineId === undefined ? machineId() : (options.machineId ?? undefined);
}

/** Same-machine judgment (#842): the stable machine id decides when both
 * sides have one; otherwise the conservative hostname comparison stands. */
function isSameMachine(record: LibraryLockRecord, host: string, id: string | undefined): boolean {
  if (record.machineId !== undefined && id !== undefined) return record.machineId === id;
  return record.hostname === host;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs permission/existence checks without sending anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user — alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockPath(dataDir: string): string {
  return join(dataDir, 'library.lock');
}

/** A reclaim guard abandoned by a crashed reclaimer is itself stale after
 * this long — reclaiming is a few filesystem calls, not seconds. */
const RECLAIM_GUARD_STALE_MS = 10_000;

function reclaimStaleLock(path: string, judgedStale: LibraryLockRecord | null, now: () => Date): void {
  const guard = `${path}.reclaim`;
  try {
    if (now().getTime() - statSync(guard).mtimeMs > RECLAIM_GUARD_STALE_MS) rmSync(guard, { force: true });
  } catch {
    // No guard present — the common case.
  }
  try {
    writeFileSync(guard, '', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LibraryLockError('library is being opened by another Overlook instance', 'held-by-instance');
    }
    throw error;
  }
  try {
    // Delete only if the lock is still byte-for-byte the record we judged
    // stale; anything newer is a live holder and stays.
    const current = existsSync(path) ? readRecord(path) : null;
    if (JSON.stringify(current) === JSON.stringify(judgedStale)) {
      rmSync(path, { force: true });
    }
  } finally {
    rmSync(guard, { force: true });
  }
}

function readRecord(path: string): LibraryLockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LibraryLockRecord>;
    if (typeof raw.instanceId === 'string' && typeof raw.pid === 'number' && typeof raw.hostname === 'string') {
      if (typeof raw.machineId === 'string' || raw.machineId === undefined) return raw as LibraryLockRecord;
      // A non-string machineId never proves anything — drop it and let the
      // hostname fallback judge, instead of rejecting the whole record.
      const { machineId: _invalid, ...rest } = raw as LibraryLockRecord;
      return rest;
    }
  } catch {
    // Unreadable/torn lock: treat as stale below — a half-written lock never
    // proves a live holder, and refusing forever on garbage would wedge the
    // library with no recovery path.
  }
  return null;
}

/** Read-only probe (#386): the hostname holding a LIVE lock on this library
 * from another instance, or null when the lock is free, ours, or stale. A
 * cross-host record counts as live — liveness cannot be verified across
 * machines, so the switcher must present it as locked-elsewhere. */
export function readLockHolder(dataDir: string, instanceId: string, options: LibraryLockOptions = {}): string | null {
  const record = readRecord(lockPath(dataDir));
  if (record === null || record.instanceId === instanceId) return null;
  if (!isSameMachine(record, options.host ?? hostname(), resolveMachineId(options))) return record.hostname;
  return (options.isPidAlive ?? defaultIsPidAlive)(record.pid) ? record.hostname : null;
}

/** Fail-loud startup probe (#842): when the startup-selected library is
 * lock-held by another live instance, the user must learn why up front —
 * a silently failing bootstrap reads as data loss. Returns the dialog
 * message naming the holder, or null when the library is openable. Same-
 * machine stale locks never reach this: acquire reclaims them. */
export function describeStartupLockHold(
  dataDir: string,
  libraryName: string,
  instanceId: string,
  options: LibraryLockOptions = {},
): string | null {
  const holder = readLockHolder(dataDir, instanceId, options);
  if (holder === null) return null;
  return (
    `"${libraryName}" is locked by another Overlook instance on ${holder} and was not opened.\n\n` +
    'Your photos are safe. Close Overlook there and relaunch, or open a different library from the library switcher.'
  );
}

/** Acquires <dataDir>/library.lock for this instance or throws
 * LibraryLockError. Returns a release function (idempotent; releases only if
 * the file still names this instance). */
export function acquireLibraryLock(dataDir: string, instanceId: string, options: LibraryLockOptions = {}): () => void {
  const path = lockPath(dataDir);
  const host = options.host ?? hostname();
  const pid = options.pid ?? process.pid;
  const id = resolveMachineId(options);
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

  const existing = existsSync(path) ? readRecord(path) : null;
  if (existsSync(path)) {
    if (existing !== null && existing.instanceId !== instanceId) {
      if (!isSameMachine(existing, host, id)) {
        throw new LibraryLockError(
          `library is locked by another computer (${existing.hostname}); locks on shared volumes cannot be verified — close it there or remove ${path} if you are certain`,
          'held-by-other-host',
        );
      }
      if (isPidAlive(existing.pid)) {
        throw new LibraryLockError(
          `library is already open in another Overlook instance (pid ${String(existing.pid)})`,
          'held-by-instance',
        );
      }
    }
    // Stale (dead pid, garbage, or our own previous run): reclaim under a
    // guard. Two post-crash racers must not both delete-then-write — the
    // loser would remove the winner's FRESH lock (PR #425 review). The guard
    // serializes reclaimers, the content re-check ensures only the exact
    // record judged stale is deleted, and the 'wx' write below remains the
    // final arbiter for anyone who slips between.
    reclaimStaleLock(path, existing, options.now ?? (() => new Date()));
  }

  const record: LibraryLockRecord = {
    instanceId,
    pid,
    hostname: host,
    ...(id === undefined ? {} : { machineId: id }),
    acquiredAt: (options.now?.() ?? new Date()).toISOString(),
  };
  // 'wx' = O_CREAT|O_EXCL: if another instance won the race between our
  // check and this write, this throws EEXIST and the open fails closed.
  try {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LibraryLockError('library is already open in another Overlook instance', 'held-by-instance');
    }
    throw error;
  }

  return () => {
    const current = existsSync(path) ? readRecord(path) : null;
    if (current?.instanceId === instanceId) {
      rmSync(path, { force: true });
    }
  };
}
