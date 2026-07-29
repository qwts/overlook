# ADR-0017: Multi-Library Registry, Per-Library Keying, and Service Lifecycle

## Status

Accepted 2026-07-16 on issue [#383](https://github.com/qwts/photos/issues/383) (proposed and owner-accepted the same day; any section may still be amended by owner veto before its implementing code lands).

**Amended 2026-07-28 (PR [#832](https://github.com/qwts/photos/pull/832)):** §4's lifecycle classification is unchanged, but the durability mechanism cited for import-batch cancel safety is updated: `import-journal.json` is now an append-only JSON Lines journal — the manifest snapshot line is written write-then-rename, per-file stage transitions are appended, a torn appended tail is dropped on replay, and the log compacts periodically (`src/main/import/import-journal.ts`). The property §4's table relies on is preserved: a torn write never corrupts previously journaled state, and an interrupted batch resumes on next open.

**Amended 2026-07-22 by [ADR-0028](./ADR-0028-Remote-Custody-Binding-And-Custody-Safe-Disconnect.md) (#723):** §6's profile-scoped credential slots stand, but a library's non-secret custody binding (which provider **account** holds its offloaded originals) is library-scoped state in its database; replacing the account behind a credential slot no longer silently repoints custody operations. Registry entries (§1) additionally carry a conservative, non-secret custody hint (provider ID, account ID, sole-custody totals, ADR-0028 §4) so profile-wide credential removal can preflight sealed libraries — a scoped exception to §1's "derived status is never persisted" rule.

This ADR extends [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md), [ADR-0005](./ADR-0005-Library-Data-Model.md), [ADR-0007](./ADR-0007-Backup-Format-And-Offload.md), [ADR-0011](./ADR-0011-Provider-Catalog-Capabilities-And-Switching.md), and [ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md); it rewrites none of them.

Section map for the epic's children: §1–§3, §7 govern [#384](https://github.com/qwts/photos/issues/384) (registry + keys), §4–§5 govern [#385](https://github.com/qwts/photos/issues/385) (lifecycle), §1, §5 and the identity rules in §2 govern [#386](https://github.com/qwts/photos/issues/386) (switcher UI), §2 and §6 govern [#387](https://github.com/qwts/photos/issues/387) (per-library scoping).

## Context

Today exactly one library exists at a hardcoded path: `dataDir = userData/library`, `library.db` inside it (`src/main/index.ts:118,130`). Epic #378 requires creating, opening, and switching between multiple encrypted libraries with no cross-library bleed and no undecided contract questions downstream.

The code is closer to per-library than the epic's framing suggests, and the design should exploit that rather than invent parallel structures:

- **Keys are already directory-scoped.** The `safeStorage`-wrapped master key (`master.key`) and the wrapped versioned library keys (`keys.json`) live inside the library data directory (`src/main/crypto/keystore.ts:40-41,119`), not under any global name. There is no keychain entry named per library; the only true OS-keychain item is the ADR-0013 anti-rollback anchor, whose account is currently `sha256(dataDir)` (`src/main/crypto/credential-anchor.ts:137`) — path-derived, so a moved library directory would falsely trip recovery-required.
- **A stable library id already exists.** `ProviderRuntime.libraryId()` lazily mints a ULID into `userData/library/library-id` (`src/main/backup/provider-runtime.ts:226-244`); ADR-0007 keys the remote at `/Overlook/<library-id>/`, and the ADR-0013 custody record embeds the same `libraryId`.
- **Teardown machinery exists but only runs on some paths.** `closeLibrary()` (`src/main/index.ts:706-743`) implements fence → cancel → drain (10 s deadline, `src/main/crypto/library-shutdown.ts`) → `db.close()` → `keyStore.close()`. It runs on app-lock and restore transitions only; an ordinary quit disposes just the restore runtime and thumbnail pool (`will-quit`, `src/main/index.ts:899-902`), never closes the DB, and no WAL checkpoint exists anywhere.
- **Nothing prevents concurrent opens.** There is no `app.requestSingleInstanceLock()` and no per-library lock.
- **Settings are app-scoped** (`userData/settings.json`, `src/main/settings/settings-runtime.ts:9`) while almost all other state — DB, keys, `library-id`, `import-journal.json`, `ephemeral/` view cache, `backup-audit.log`, protected stores — already lives under the library directory.

## Decision

### 1. Registry — a standalone, main-owned `userData/libraries.json`

The registry is a versioned standalone file, **not** part of `settings.ts`:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "01J9ZC3AC9V2J6ZK6NQ4R8W5T1",
      "name": "Personal",
      "path": "/Users/…/userData/library",
      "createdAt": "2026-07-16T00:00:00.000Z",
      "lastOpenedAt": "2026-07-16T00:00:00.000Z"
    }
  ]
}
```

- **Location**: `userData/libraries.json` (profile root, beside `settings.json` — it is per-profile state about libraries, not state of any one library).
- **Writer**: the main process only, atomic temp-file + rename (the `settings-store.ts` convention). The renderer reads and mutates exclusively through new zod-validated IPC channels (`src/shared/ipc/channels.ts`); there is no renderer-side patch surface.
- **Why not settings**: the settings store deliberately self-heals — unparseable values silently reset to defaults per key (`src/shared/settings/settings.ts:55-74`). That is correct for preferences and catastrophic for a registry: a corrupted registry must **fail loud** into a recovery flow (re-add / locate libraries), never silently forget where libraries live. Registry entries are also entities with identity, not flat preferences, and must never be renderer-patchable as a partial object.
- **Entry fields** are exactly `id` (library ULID, §2), `name` (display name, user-editable), `path` (absolute directory path), `createdAt`, `lastOpenedAt` (nullable). Derived status — missing, locked by another instance — is computed at read time, never persisted.
- **Startup selection**: open the entry with the newest `lastOpenedAt`; if the registry is empty, absent (see §7), or the chosen entry is unopenable, show the library picker (#386). `lastOpenedAt` is stamped at successful open, not at close, so a crash never loses it. There is no separate `currentLibraryId` field — that would be a second copy of the same fact.

### 2. Library identity — the existing ULID, minted eagerly; provider identity is the same id

- **One id.** The library's identity is the ULID already defined by ADR-0007 ("the ULID minted at library creation"). It is minted **eagerly at library creation** (no longer lazily on first provider use) and stored in two places: the `library-id` file inside the library directory (authoritative — it travels with the directory) and the registry entry (a cache for display/dedup).
- **Provider identity = library identity.** `getProviderRuntime().libraryId()` keeps returning this ULID; the remote stays `/Overlook/<library-id>/` (ADR-0007 unchanged). Per-library backup identity therefore falls out of the id model — no mapping table exists or is needed. The ADR-0013 custody record's `libraryId` is the same ULID.
- **Open-time verification.** On open, read `library-id`; if absent (pre-registry library), mint-and-write exactly as today (`provider-runtime.ts:237-243` semantics, moved to open). If it differs from the registry entry's cached id, the directory wins: heal the registry entry and surface a notice.
- **Copied libraries.** Two directories carrying the same ULID would be two writers on one `/Overlook/<id>/` remote — forbidden by ADR-0007. Adding or locating a library whose ULID already exists in the registry at a _different, still-existing_ path forces an explicit choice in the UI (#386): **"moved"** (re-point the existing entry, keep the id) or **"copy"** (mint a fresh ULID into the new directory's `library-id`, giving it a fresh, empty backup home; local content is untouched). No silent default.

### 3. Per-library key model and app-lock scope

- **Layout is already correct — keep it.** Each library directory owns its `master.key` and `keys.json`; `KeyStore` continues to take the library `dataDir` and nothing else (`keystore.ts:97-103`). No global key state exists.
- **Provisioning on create** is today's first-run path, run against the new directory: create the directory, mint `library-id` (§2), `KeyStore.open()` generates the master key and KEY #1 (`keystore.ts:114-143`), insert the `keys` FK row, open the SQLCipher DB with KEY #1 (`src/main/index.ts:126,137-142`). A create that fails midway is deleted wholesale — before the first successful open, the directory is disposable.
- **Recovery keys are per-library.** The ADR-0008 recovery file seals one library's master key; nothing is shared between libraries. Recovery UX (#386) must display which library a recovery file belongs to; the ADR-0009 bootstrap already carries the library id for this.
- **App lock is per-library.** The OVLK custody record, password, and unlock ceremony are properties of one library directory (ADR-0013 unchanged). The `AppLockController`'s session unlock state refers to the open library only; closing a library (switch, quit, lock) zeroes its unwrapped keys via `keyStore.close()` (`keystore.ts:248-252`), so a switch inherently locks the previous library. Per-library lock preferences move with settings (§6). Different libraries may have different passwords or no lock at all.
- **Anchor re-keying (ADR-0013 implementation amendment).** The anti-rollback anchor's keychain account changes from `sha256(dataDir)` to the library ULID; the service name is unchanged. This keeps the anchor valid across library moves (path changes, §5) while preserving every ADR-0013 property — the anchor stays outside the library directory and still stores `{libraryId, generation, SHA-256(record)}`. Migration: on first unlock of a configured library with no ULID-keyed anchor, if a `sha256(dataDir)`-keyed anchor exists and its `libraryId` matches the custody record, write the ULID-keyed anchor first, then delete the old one (two-phase, same discipline as ADR-0013 transitions). A copied library that detaches with a fresh ULID (§2) has no anchor under its new id and therefore enters ADR-0013's recovery-required path if it was lock-configured — correct, since the copy is a "fresh machine" from the anchor's perspective.
- **Honest isolation claim.** `safeStorage` grants are per-app, not per-library: the OS will unwrap any library's `master.key` for the app. Cross-library isolation is enforced by lifecycle — keys are unwrapped only when their library opens and zeroed at close — not by per-library OS ACLs. UI copy must not claim otherwise (ADR-0004's factual-copy rule).

### 4. Service lifecycle — one teardown contract for switch, lock, restore, and quit

`closeLibrary()`'s existing shape becomes the **single, universal** teardown contract. The ordinary-quit gap (teardown currently runs only when app lock is configured — `before-quit` in `src/main/crypto/app-lock-lifecycle.ts:44-50`) is a defect #385 closes: quit, switch, lock, and restore-activation all run the same sequence.

**Drain vs cancel classification.** A service _cancels_ when persistent journals/ledgers make abandoned work resumable; it _drains_ when in-flight work is destructive or user-visible and must reach a safe boundary:

| Service                      | Policy                                                                                                             | Why it is safe                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import batch                 | Cancel (abort), then drain the turn queue                                                                          | `import-journal.json` append-only journal (torn-tail-safe replay, amended 2026-07-28) resumes or rolls back on next open (`src/main/import/import-journal.ts`, `src/main/import/import-service.ts:186-221`) |
| Import scans                 | Cancel                                                                                                             | Read-only                                                                                                                                                                                                   |
| Thumbnail pool               | Cancel — reject queue, terminate workers (`thumbnail-pool.ts:75-83`)                                               | Derivatives are re-derivable from originals                                                                                                                                                                 |
| Thumb / full-res LRU caches  | Close (drop)                                                                                                       | Pure caches                                                                                                                                                                                                 |
| Backup runs                  | Abort controllers, await run promises                                                                              | `sync_ledger` dirty set is the durable queue (`backup-engine.ts:18-24`); verify-after-upload (ADR-0007) makes partial uploads re-checkable                                                                  |
| Auto-backup debounce         | Cancel timer                                                                                                       | Ledger persists intent                                                                                                                                                                                      |
| Export                       | Drain in-flight items to completion boundary                                                                       | User-visible artifacts outside the library                                                                                                                                                                  |
| Purge + protected migrations | Drain to step boundary; cancellation only **at** boundaries                                                        | Destructive two-phase work; journaled (`purge-runtime.ts:33-42`, ADR-0013 migration journal)                                                                                                                |
| Startup maintenance          | Cancel timer, drain in-flight repair                                                                               | Idempotent                                                                                                                                                                                                  |
| Restore                      | Neither — a switch or quit is **rejected** while a restore is activating (ADR-0011 parity with provider switching) | Restore staging/activation is atomic and must not race teardown                                                                                                                                             |

**Ordering** (codifying `src/main/index.ts:706-743` plus two additions in bold):

1. Fence intake: null the auto-backup/manifest triggers, close admission gates — no new work is accepted.
2. Cancel every cancellable (table above).
3. `drainWithCancellationFence` with the existing **10-second deadline**, re-cancelling after the drain to catch re-armed callbacks (`library-shutdown.ts:33-42`). On deadline breach: log, hard-terminate remaining workers, proceed — journals guarantee consistency, and quit must never hang.
4. Close caches and pools.
5. **`PRAGMA wal_checkpoint(TRUNCATE)`**, then `db.close()`.
6. `keyStore.close()` — zero the master and all unwrapped library keys.
7. **Release the per-library lock file** (§5).

**WAL checkpoint policy.** WAL mode stays (ADR-0005). A clean close checkpoints with `TRUNCATE` so the closed library directory is a complete, copy/eject-safe unit with no live `-wal`/`-shm` sidecars. A crash leaves sidecars behind; SQLite replays them on next open — both states are valid, and no code ever deletes sidecar files manually.

**Switch = teardown(old) → open(new).** The renderer performs a full reset (hard reload of the window at open of the new library) so no renderer-held state — grid data, search text, selection, decrypted object URLs — survives a switch. A crash between teardown and open is recovered by startup selection (§1): each library is independently consistent via WAL replay plus its journals; there is no cross-library state to corrupt.

### 5. Single-instance locking and path health

- **Profile level**: adopt `app.requestSingleInstanceLock()`; a second app instance on the same profile focuses the first and exits. E2E's per-run `OVERLOOK_USER_DATA` profiles (`src/main/index.ts:77-78`) are distinct profiles and are unaffected.
- **Library level**: opening a library takes `<libraryDir>/library.lock`, created with `O_EXCL`, containing `{instanceId, pid, hostname, acquiredAt}`. On conflict: same hostname and dead pid → stale, reclaim; same hostname and live pid → refuse to open ("already open in another window/instance"); different hostname (network share) → refuse, with an explicit force-override that warns the lock cannot be verified. The lock is advisory — it orders honest actors; it is released at teardown step 7 and reclaimed-by-liveness after a crash.
- **Removable and network storage**: removable volumes are supported normally (the clean-close checkpoint in §4 makes eject-after-close safe). Network filesystems are **unsupported-but-not-blocked**: SQLite WAL on network mounts is unsafe, so opening a library on a detected network mount shows a strong warning and the cross-host lock caveat above.
- **Missing / moved paths**: a registry entry whose path fails to stat is flagged `missing` at read time (not persisted, §1). The picker (#386) offers **Locate** — re-point after verifying the chosen directory's `library-id` matches the entry (§2's moved-vs-copy rule applies) — or **Remove**, which forgets the entry and touches nothing on disk. `Remove` never deletes library contents.

### 6. Settings and cache scope

- **App-scope** (stays in `userData/settings.json`): `appearance`, `shareDiagnostics` — preferences about the app, not about a library.
- **Library-scope** (moves to `<libraryDir>/settings.json`, same atomic store mechanics and per-key self-healing as today): `sortOrder`, `thumbnailsOnImport`, `autoBackupOnImport`, `reOffloadAfterViewing`, `importMode`, `wifiOnly`, `bandwidthLimit`, `appLockIdle`, `lockWhenHidden`, `providerId`. Self-healing stays correct here — these are preferences; the registry (§1) is what must fail loud.
- **Provider credentials stay profile-scoped** at `userData/provider-auth/<providerId>` (`src/main/index.ts:385`): they authenticate an account, not a library. A library selects a provider via its own `providerId`; two libraries may share one connected account, and each still writes only inside its own `/Overlook/<library-id>/` (§2). ADR-0011 connect/disconnect semantics are unchanged.
- **Everything else already follows the directory**: `import-journal.json`, `ephemeral/` offload view cache, `backup-audit.log`, `blobs/`, `thumbs/`, protected stores. #387's job is verification that nothing profile-scoped leaks library content — plus clearing the in-memory residue (LRUs, ephemeral cache, ledger handles) that §4's teardown already owns.

### 7. Migration — register in place, never move

On first run of registry-aware code, if `userData/libraries.json` is absent and `userData/library/library.db` exists, write a registry containing one entry: `id` from the existing `library-id` file (minted now if absent), `name` = "My Library", `path` = `userData/library`, `createdAt` = `lastOpenedAt` = now. **No files move.** The legacy path stays valid indefinitely — after #384/#385, all consumers resolve paths through the registry and nothing hardcodes `userData/library` (epic product rule). New libraries default to `userData/libraries/<ulid>/`; any user-chosen writable directory is equally valid. If neither registry nor legacy DB exists, first run goes to the create-library flow (#386).

## Consequences

- **Easier**: most per-library state already lives in the library directory, so #384 is mostly registry + path-plumbing rather than data migration; per-library backup identity is free (§2); the teardown contract is a codification plus two fixes (quit path, WAL checkpoint) rather than new machinery.
- **Harder**: two settings scopes must be kept honest (§6) and migrated once; the ADR-0013 anchor re-keying adds a one-time two-phase migration; lock files on network shares are only advisory and the UI must say so plainly.
- **Deferred, with owners**:
  - Moved-vs-copy dialog copy and recovery-file labeling UX — #386.
  - Depth of network-share support (currently warn + advisory lock; anything stronger is a new decision) — #385 implements the warning; revisiting the policy needs an ADR amendment.
  - Multi-account provider credentials per library (`provider-auth` today is profile-global) — out of epic scope (#378 explicitly excludes multi-user); file a new issue if wanted.
  - Multi-window (several libraries open at once) — out of epic scope; would require per-window `LibraryParts` and is the main reason §4 keeps a single global teardown.
- **Revisit when**: semantic-search indexes land (#379) — they must live inside the library directory and appear in §4's table; face grouping (#285) likewise.
