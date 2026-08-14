# ADR-0022: Library Relocation and Registry Path Rewrite

## Status

Accepted 2026-07-19 on issue [#483](https://github.com/qwts/photos/issues/483)
(proposed and owner-accepted the same day; any section may still be amended by
owner veto before its implementing code lands). This ADR extends
[ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md) (registry §1,
identity §2, teardown §4, locking and path health §5) and applies the
staging-and-atomic-activation discipline of
[ADR-0010](./ADR-0010-Cloud-Restore-Staging-And-Atomic-Activation.md) to the local
filesystem; it rewrites neither. §3 below is this ADR's one explicit amendment
to ADR-0017 §2.

Section map for [#483](https://github.com/qwts/photos/issues/483): §1–§2 govern
the relocation service and its journal, §3–§4 the staging identity rule and the
copy/verify/commit protocol, §5 preflight and refusals, §6 external-volume
behavior, §7 multi-library moves.

## Context

- **The registry has no relocation operation.** `LibraryRegistry` exposes
  `register` / `remove` / `updateId` / `rename` / `touchOpened` — nothing
  rewrites an entry's `path` (`src/main/library/library-registry.ts:35-125`).
  Manually moving a directory strands its entry, and the only repair is the
  picker's Locate flow (ADR-0017 §5, #386). #483 requires an in-app move.
- **ADR-0017 already decided most of what a move needs.** Identity travels with
  the directory (`library-id` is authoritative, §2;
  `src/main/library/library-id.ts:21`); the anti-rollback anchor is keyed by
  the library ULID precisely so it survives path changes (§3); a clean close
  checkpoints WAL so the closed directory is a complete, copy-safe unit (§4;
  `src/main/index.ts:695-701`); the advisory lock and missing-path handling
  exist (§5; `src/main/library/library-lock.ts:111`). Relocation composes this
  machinery — it is not new identity or lifecycle design.
- **But ADR-0017 §2 forbids the state a safe move requires.** §2 bans two
  directories carrying one ULID and forces an explicit moved-vs-copy choice
  when one is discovered. A copy-based move deliberately creates that state
  between first copied byte and source cleanup. Without a decided carve-out,
  the #386 locate/add flow and the #483 relocation service contradict each
  other, and crash recovery cannot tell relocation staging from a user's copy.
- **ADR-0010 already solved this shape for cloud restore**: sibling staging, a
  checkpoint bound to library identity, verify-before-activate, rename-based
  activation, and startup recovery of stranded directories. Relocation is that
  discipline run disk-to-disk with no provider in the loop.
- **Staging can never be registered.** The registry schema rejects duplicate
  ids at parse time (`src/shared/library/registry.ts:29-37`), so staging
  recognition must work from the filesystem and a journal, outside the
  registry.

## Decision

### 1. Relocation is a main-process registry transaction

- A journaled relocation service lives below the renderer in the main process;
  the renderer drives it only through new zod-validated channels in the IPC
  registry (`src/shared/ipc/channels.ts`). There is no renderer patch surface.
- The registry gains exactly one new mutation: an atomic **path rewrite**
  (`updatePath(id, newPath)` shape) using ADR-0017 §1 mechanics (main-owned,
  temp-file + rename). The source entry stays registered and **authoritative
  for the entire move**; the rewrite is the commit point and runs only after
  full verification (§4). What a registered path _means_ is unchanged — it is
  the library's one authoritative location; relocation adds a governed
  transition between two such locations.
- Relocation is local filesystem work. It never uploads, downloads,
  re-imports, re-encrypts, or deduplicates. The library ULID, the
  `/Overlook/<library-id>/` remote namespace, provider auth, backup ledgers,
  and custody records are untouched (ADR-0007/ADR-0013 unchanged); the anchor
  survives because it is ULID-keyed, not path-keyed (ADR-0017 §3).

### 2. Journal and staging marker

- Each move writes a relocation journal at
  `userData/relocations/<libraryId>.json` — main-owned, `version: 1`
  strict-schema, atomic temp-file + rename (the restore-checkpoint
  conventions, `src/main/backup/restore-staging.ts:9-38`), **fail-loud** like
  the registry (never self-healing; ADR-0017 §1's rationale). It records
  `{version, libraryId, sourcePath, destPath, stagingPath, mode, state}` with
  states `copying → verified → committed → cleaned` (`mode` is copy vs
  same-volume rename, §4). Unlike the restore checkpoint it lives in the
  profile root, not inside staging: recovery must still run when the
  destination volume is unplugged, so the journal cannot live on it.
- Staging is a sibling of the final destination **on the destination volume**,
  named `<finalDir>.relocate-staging` (parallel to ADR-0010's
  `library.restore-staging`), so activation is a same-volume atomic rename.
  Staging carries a marker file `relocation.json` binding it to its journal
  (library ULID + journal nonce). **The marker, not the directory name,
  defines staging**: it travels through the activation rename, so a crash
  between activation and commit leaves the final-path directory still
  marker-bound and therefore still staging (§3) — the source stays
  authoritative and resume-or-discard applies. The marker is deleted
  immediately after the registry commit; a crash in that window resolves from
  the `committed` journal plus the registry already pointing at the
  destination.
- Startup recovery reads journals, not guesses: pre-commit states resume or
  discard staging; a `committed` journal with a surviving source finishes
  cleanup; disk state matching no journal is never silently acted on.

### 3. Amendment to ADR-0017 §2 — relocation staging is not a second library

ADR-0017 §2's rule — the same ULID at two still-existing paths forces an
explicit moved-vs-copy choice — applies to **user-visible library
directories**. A directory carrying a relocation marker that matches a live
journal is relocation staging: it is never listed, never offered to add or
Locate, never triggers the moved-vs-copy dialog, and is only ever resumed or
discarded by §2's recovery. A marker with no matching journal makes the
directory inert — surfaced as a repair/cleanup action, never treated as a
library. The two-writer prohibition itself is unchanged: staging never opens
for writing and never contacts the remote; the source remains the sole writer
until commit.

### 4. Copy → verify → commit → cleanup protocol

Ordered; every numbered boundary is a crash/cancel test point (#483
acceptance 6):

1. **Quiesce.** Active library: the full ADR-0017 §4 teardown — fence →
   cancel/drain → WAL checkpoint → close → zero keys → release lock
   (`closeLibrary`, `src/main/index.ts:669`). Inactive library: take its
   advisory lock (`src/main/library/library-lock.ts:111`); refuse if live-held
   by another instance (§5).
2. **Copy** the closed, checkpointed directory into staging. Bytes are copied
   as-is; nothing decrypts and no plaintext is persisted.
3. **Verify**: every file by relative path, size, and SHA-256 digest (the
   house algorithm — ADR-0010's manifest binding, ADR-0013's anchor hash; the
   marker file is excluded from the comparison set); the staged `library-id`
   equals the entry id; the staged database opens with the existing key
   custody (read-only health check), then closes.
4. **Activate**: rename staging → final destination (same-volume, atomic).
   The marker travels with it (§2).
5. **Commit**: the atomic registry path rewrite (§1), then delete the marker.
   Before this step the source is authoritative; after it, the destination
   is.
6. **Reopen** and health-check the destination when the active library moved —
   with the same full renderer reset as a switch (ADR-0017 §4).
7. **Cleanup**: remove the source. Failure here leaves two verified copies;
   the journal stays `committed`, the UI reports both paths and offers safe
   retry — the app never guesses which copy to delete.

Cancellation, crash, volume disconnection, full disk, I/O error, or
verification failure at or before step 5 leaves the original library
registered and usable; recovery (§2) discards or resumes staging.

**Optimized same-volume rename** is permitted only as steps 2–4 collapsed into
one `rename(source → finalDir)`, with the journal recording the intent
_before_ the rename: a crash between rename and commit is then repaired from
the journal (complete the commit, or reverse the rename — the journal wins).
The guarantee set must be identical to the copy path; cross-volume moves
always copy.

### 5. Preflight and refusals

- Preflight runs before any bytes move: destination writability, free space
  (library size plus scratch), path collision — never create over, merge into,
  or overwrite a non-empty directory or any registered path — source
  readability, and filesystem support. Failures map to stable, user-showable
  reasons (ADR-0010's discipline).
- Network-mount destinations get ADR-0017 §5's unsupported-but-not-blocked
  treatment: strong warning plus the advisory-lock caveat. Anything stronger
  is a new decision (ADR amendment).
- An inactive library whose lock is live-held by another instance refuses to
  move; same-hostname dead-pid locks are stale and reclaimable per
  ADR-0017 §5.
- **Cloud backup is advisory, never a gate.** The §4 guarantees hold with or
  without a backup: at every instant one verified authoritative copy exists,
  and the only destructive step runs after two copies verify. Requiring an
  active, fully-synced backup would couple a local, offline-capable operation
  to network availability and an optional feature — and a blocked user's
  fallback is a manual Finder move with no verification or journal, the exact
  hazard #483 exists to remove. Preflight instead **reports** backup posture
  in the confirmation UI: active and current; active with N items pending
  (recommend letting backup finish first); or not configured (one-line
  advisory). Nothing blocks. A backup run in flight is quiesced by §4 step 1
  like any other service — the sync ledger preserves its intent across the
  move, and the unchanged ULID (§1) leaves the remote namespace untouched.

### 6. External-volume behavior

- Extends ADR-0017 §5 missing-path handling: the derived `missing` status
  distinguishes volume-unmounted from path-gone, and the picker adds
  **Reconnect volume** beside **Locate**. Locate keeps §2's ULID verification
  (accept the matching id, reject any other).
- A missing library is never re-created empty (the #385 fail-loud rule) and
  never routes to cloud restore: restore stays an explicit user action
  (ADR-0009/ADR-0010). A disconnected disk is not data loss.
- Volume removal during copy, verify, or open aborts before commit — the
  source stays authoritative. Stable remount paths are supported to the
  extent the OS provides them; a changed mount path surfaces an actionable
  error, never a silent re-point.

### 7. Multi-library moves

A multi-select move is N independent single-library relocations sharing a
destination root — one collision-safe directory per library, one journal per
library, independent progress and per-library results. There is no
cross-library transaction: one library's failure never rolls back another's
commit.

### 8. Amendment: destination authorization

Relocation destinations cross the renderer-to-main filesystem boundary. The
main process therefore issues an unguessable authorization when its native
directory picker returns, binds that authorization to the selected root, and
rejects preflight or move requests outside that root. A renderer-provided path
alone is never authority to write, move, or delete library data. One picker
authorization may cover the child destinations of a multi-library move (§7).

## Consequences

- **Easier**: relocation composes already-accepted machinery — identity (§2),
  ULID-keyed anchor (§3), universal teardown (§4), advisory locks and
  missing-path status (§5) from ADR-0017, plus ADR-0010's staging discipline —
  so the new surface is one registry mutation, one journal, and the copy
  engine. Nothing provider- or remote-side changes at all.
- **Harder**: a second journaled-recovery surface (relocation journals) now
  exists beside restore staging and must be honored at startup; the §3 staging
  exemption must be enforced everywhere directories are scanned (picker
  add/locate, startup selection); the two-verified-copies end state needs
  honest UX, not auto-deletion.
- **Deferred, with owners**:
  - Moving the profile itself (`userData`, registry included) — out of scope;
    a new decision if ever wanted.
  - Locate-after-reinstall ([#479](https://github.com/qwts/photos/issues/479))
    shares §6's identity-safe Locate but is its own issue.
  - Depth of network-share support stays where ADR-0017 §5 left it — warning
    plus advisory lock; revisiting needs an ADR amendment.
- **Revisit when**: semantic-search indexes
  ([#379](https://github.com/qwts/photos/issues/379)) or face data
  ([#285](https://github.com/qwts/photos/issues/285)) land inside the library
  directory — a whole-directory copy carries them automatically, but their
  services must join ADR-0017 §4's drain table before an active-library move
  can quiesce them.
