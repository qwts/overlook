# ADR-0033: Backup Coverage Exceptions and Local-Only Custody

## Status

Accepted 2026-07-29 on
[#794](https://github.com/qwts/overlook/issues/794). This ADR governs
[#506](https://github.com/qwts/overlook/issues/506) and **amends the restore
promise** of
[ADR-0007](./ADR-0007-Backup-Format-And-Offload.md): a cloud restore
reconstructs every photo whose coverage is `included`, and photos the user
excluded are not recoverable from it. It also extends
[ADR-0005](./ADR-0005-Library-Data-Model.md),
[ADR-0009](./ADR-0009-Cloud-Recovery-Bootstrap-And-Manifest-V2.md),
[ADR-0010](./ADR-0010-Cloud-Restore-Staging-And-Atomic-Activation.md),
[ADR-0011](./ADR-0011-Provider-Catalog-Capabilities-And-Switching.md),
[ADR-0012](./ADR-0012-Continuous-Backup-Integrity-And-Recovery-Repair.md),
[ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md),
[ADR-0023](./ADR-0023-Trash-Purge-And-Destructive-Action-Ceremony.md),
[ADR-0028](./ADR-0028-Remote-Custody-Binding-And-Custody-Safe-Disconnect.md),
and
[ADR-0031](./ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md); it
rewrites none of their custody or deletion guarantees.

Section map: §1 defines coverage state; §2 the transition into an exception;
§3 shared-byte and variant custody; §4 manifest, restore, and recoverability
disclosure; §5 re-enabling; §6 failure, crash, provider, and protected-domain
behavior; §7 the ADR-0023 ceremony and purge-disclosure updates.

Implementation may choose column, service, and channel names. No child issue
may change the coverage states, the ordering invariant in §2, the shared-byte
rule in §3, or the disclosure obligations in §4 without an ADR amendment.

## Context

Every backup claim Overlook makes today rests on a single implied premise:
that backup covers the whole library. `sync_ledger` has four states
(`local | syncing | synced | offloaded`) and a `dirty` bit, and all four
describe _progress toward_ a complete mirror. There is no way to say "this
photo is deliberately not in the cloud", so #506's feature would have to
express a permanent user choice using vocabulary that means "not finished
yet".

That gap is not cosmetic:

- a photo whose remote copy is deleted would fall back to `local` — the same
  state as a photo waiting to upload — and automatic backup would helpfully
  upload it again;
- the disaster-recovery surface tells the user what a restore will return. If
  exclusions are invisible to it, a restore silently returns fewer photos than
  the library had, and the user discovers the gap after the disk is gone;
- ADR-0007's offload path makes the remote copy the _only_ copy for offloaded
  photos, so "remove the cloud copy" is a data-destruction operation dressed as
  a settings toggle;
- content addressing (ADR-0005) means one encrypted blob can be the custody for
  several rows, so deleting "this photo's" remote object can remove another
  photo's only backup;
- ADR-0023's purge ceremony enumerates which copies die. If some photos have no
  cloud copy by choice, that enumeration is wrong for them.

#506 therefore cannot be built without first deciding what backup _coverage_
is, and saying out loud that the ADR-0007 recovery promise now has a documented
exception.

## Decision

### 1. Coverage is durable ledger state, orthogonal to sync status

`sync_ledger` gains three columns:

- `coverage` — `included` (default) or `excluded`;
- `coverage_origin` — `user`, `protected-domain`, or `provider-unsupported`;
- `coverage_since` — when the current coverage was decided.

`status` keeps its existing meaning and continues to describe progress. The two
are read together, and an excluded row is **never** presented as `synced`,
`offloaded`, or `local`. It has its own state and its own StatusGlyph entry,
because a user choice and an unfinished upload are different facts and must
never share a glyph.

**Local-only** is the user-facing name for `excluded` with origin `user`.
Automatic backup skips excluded rows entirely: they are not queued, not counted
as pending, and never contribute to a dirty count. Nothing in the system may
transition a row to `excluded` on its own — exclusion is a user action, or a
structural rule (§6), and never a reaction to disk pressure, quota, provider
error, or a failed upload.

Storage and coverage totals distinguish five populations, and no surface may
collapse them: **backed up**, **local-only by choice**, **pending upload**,
**error**, and **never backed up**. The last two are failures; the second is a
decision. A single "not backed up" number that mixes them is the exact
dishonesty this ADR exists to prevent.

### 2. The exception is published before the remote is destroyed

The transition into an exception is a state machine with durable intermediates,
so a crash resumes rather than guesses:

1. **Quiesce.** A row that is `syncing`, dirty, or has an in-flight temporary
   custody lease is settled first. An in-flight upload is never raced.
2. **Prove local custody.** The photo must have a verified local original. When
   the row is `offloaded` — the remote is the only original — the encrypted
   envelope is downloaded, every chunk authenticated, the plaintext re-hashed
   against its content address, and the ciphertext promoted into the durable
   blob store through ADR-0007's **Keep downloaded** path. Verification failure
   aborts the whole transition; nothing is deleted.
3. **Record the intent durably**, moving the row to an `excluding` state that
   already means "this photo is not covered by backup".
4. **Publish and verify a manifest generation that already records the
   exclusion** (§4), through ADR-0009's bootstrap-then-manifest publication with
   its checksum verification. Until this generation verifies, nothing remote is
   deleted.
5. **Delete the remote object**, through the provider's recoverable deletion
   where one exists (ADR-0023's #750 amendment applies unchanged), with retries;
   `not-found` counts as success.
6. **Settle** to `excluded`.

Two invariants fix that order, and neither may be relaxed for convenience.

**Intent is durable before anything is destroyed** (step 3 before step 5). A
crash or provider failure therefore strands an **audited surplus remote copy** —
visible, repairable, retried — and never leaves a row that claims a cloud copy
exists when it does not. That is ADR-0023 §4's blast-radius rule applied to a
new operation.

**The newest published manifest never names a blob that has been deleted**
(step 4 before step 5). The generation published at step 4 already carries the
photo as `excluded` with no blob reference, so it is consistent whether or not
the object has actually gone yet: an object still present is surplus, which
§6's scrub reports as a repairable orphan. Deleting first would leave a window
in which the newest generation still describes the photo as `included` and
points at bytes that no longer exist — and §4's activation rule makes an
`included` record with a missing blob block the restore. A device lost inside
that window would turn a local-only choice into an unrestorable backup, so the
window is closed by ordering rather than by shortening it.

ADR-0007 retains the previous two generations, which may still describe the
photo as `included`. Their blob references dangle exactly as they do after a
purge, which correctly makes them ineligible restore fallbacks under ADR-0010's
validation — the same disclosure ADR-0023 §5 already makes for purge.

No step may report success it did not observe: the cloud copy is described as
removed only after the provider acknowledged the delete.

### 3. Shared bytes and variants gate remote deletion

ADR-0005 addresses blobs by plaintext content hash, and ADR-0031 lets several
variants reference one original asset. A remote object is therefore custody for
a _set_ of rows, not for one photo.

**The remote copy of an original may be deleted only when every live and
soft-deleted row referencing that original asset is excluded**, proven by the
same foreign-key check in the same transaction that ADR-0031 §3 and ADR-0023 §4
use for purge refcounting. A cached count is never sufficient on its own.

When the set is mixed, the user's choice is still honored at row granularity
and the disclosure changes rather than the outcome: the row records
`excluded/user`, and the surface says the cloud copy is retained because
another photo shares those bytes, naming how many. This is a case the
confirmation must state _before_ the action, not a footnote afterwards —
otherwise "remove cloud copy" is a promise the system cannot keep.

Excluding one variant never excludes its siblings, and never affects the
original asset's remote custody unless the whole set is excluded.

### 4. Manifest, restore, and recoverability disclose exclusions

Coverage enters the manifest at **the next free forward-only schema version**,
in ADR-0009's style. It is not schema 3: `BACKUP_MANIFEST_SCHEMA_VERSION` is
already 6 (`src/main/backup/backup-manifest.ts`) and schema 3 means
protected-album recovery records, so reusing it would either be rejected by the
existing parser or silently reinterpret valid schema-3 backups. The new
generation adds:

- a per-photo `coverage` field, and
- library-level `excludedCount` and `excludedBytes` totals.

Every earlier schema keeps the meaning it already has, and the restore path
continues to parse each of them; a manifest written before coverage existed is
read as having no exclusions, which is exactly what it meant when it was
written.

An excluded photo appears in the manifest as a **metadata-only record with no
blob reference**. Validation is strict in both directions, matching ADR-0009's
posture: an `included` record without a canonical `blobs/<h2>/<hash>` reference
is invalid, and an `excluded` record _with_ one is invalid. The manifest is
sealed under the library key, so recording the exclusion discloses nothing to
the provider that the object count did not already imply.

Including exclusions rather than omitting them is the central disclosure
decision. An omitted photo is indistinguishable from a photo that never
existed; a recorded exclusion survives the disaster and tells the user exactly
what they chose and when.

**Restore** (ADR-0010) reconstructs excluded records as explicit
**not-in-this-backup placeholders**: the row, its metadata, its album
membership and position, and the date the exclusion was recorded. They are not
restored as broken photos, are never counted as recovered, and can be cleared
in one reviewed bulk action. Activation validates coverage the same way it
validates blobs — an `included` record whose blob is missing still blocks
activation, and an excluded record's absent blob is not an integrity finding.

**Recoverability surfaces** — the restore preview, the backup summary, and the
disaster-recovery panel — state the exclusion count and bytes wherever they
claim recoverability, in the same sentence as the claim. "Your library is
backed up" is only sayable when `excludedCount` is zero; otherwise the honest
form names the exception: _"N photos (X GB) are on this device only, by your
choice, and will not come back from a cloud restore."_

A restore that finds only pre-coverage generations therefore behaves exactly as
it does today.

### 5. Re-enabling is a normal upload, never a shortcut

Returning a row to `included` clears the exception, marks the row dirty, and
enqueues an ordinary upload with ADR-0007's verify-after-upload. No state is
reused from before the exclusion: the remote object is created and verified
from scratch, because the previous one was deleted and its provider-side
retention is not custody Overlook may claim.

If the local original is missing when coverage is re-enabled, the operation
fails closed and the row moves to `error` with ADR-0012's integrity vocabulary.
It must never report a backup of bytes it does not have.

Re-enabling is an explicit action per photo or per reviewed selection.
Reconnecting a provider, switching providers, running a manual backup, or
restoring a library never re-includes anything.

### 6. Failures, providers, and the protected domain

- **Provider failure during remote deletion.** Coverage is already durable, so
  the row stays excluded and the remote object is recorded as an audited
  orphan with ADR-0023 §4's `ORPHAN-REMOTE` vocabulary, retried by later backup
  runs and by ADR-0012's integrity page. The surface says _removal pending_,
  never _removed_, and the pending orphan is visible with the photo.
- **Auth expiry, offline, and cancellation** abort before step 4 without
  changing durable state, or leave the resumable `excluding` state if they
  interrupt it. Either way the next run continues from the recorded intent.
- **Crash safety** follows from §2: every step is idempotent, and the remote
  delete is retried against a `not-found` response that counts as success.
- **The ADR-0012 scrub is the backstop.** Its walk skips excluded rows for
  remote-presence checks — an excluded row is _supposed_ to have no remote
  object — and instead reports a remote object that still exists for a fully
  excluded original as a repairable orphan. It continues to verify local
  custody for excluded rows, because for them the local copy is the only copy.
- **Coverage is library-level, not per provider.** Switching providers
  (ADR-0011) or binding a new custody authority (ADR-0028) carries exclusions
  forward unchanged. A newly connected provider's first sync must skip excluded
  rows; a provider that cannot delete objects is refused as a coverage-exception
  host and the exception is not offered for rows bound to it, with that exact
  reason.
- **Protected-domain photos (ADR-0013) keep their coverage inside the protected
  domain.** Their exclusions never appear in ordinary counts, totals, or
  manifest records while the album is locked, and changing a protected photo's
  coverage requires the album to be unlocked. `provider-unsupported` and
  `protected-domain` origins are system-set; only `user` is user-set, and only
  `user` exclusions are re-enablable from ordinary surfaces.

### 7. Ceremony and purge disclosure

Two entries join ADR-0023 §7's destructive-action registry:

- **Remove cloud copy** — **Tier D**. Irreversible remote destruction. Its
  ceremony names the exact count and bytes, names the provider and account,
  states that one verified local original exists for every selected photo
  (§2 step 2 having already proven it), states that the photos will not come
  back from a cloud restore, and names the partial-failure behavior. For a
  selection containing photos whose bytes are shared with non-excluded rows, it
  states that count and what will _not_ be deleted (§3).
- **Keep on this device only** — **Tier M** when no remote copy exists. It
  destroys nothing, and its copy must say so: the photo stays exactly where it
  is and simply stops being uploaded. Choosing it for a photo that _does_ have
  a remote copy escalates to the Tier D ceremony above, because the two
  outcomes differ.

ADR-0023 §5's honest sentence gains two cases:

- purging a photo whose coverage is `excluded` has **no** cloud copy to remove.
  The ceremony says that instead of promising a cloud deletion, and still
  discloses that encrypted records naming the photo can persist in up to two
  older manifest generations until they rotate away;
- purging a photo with a pending remote-deletion orphan discloses the pending
  orphan and that the purge inherits its retry.

ADR-0023 §4's derived-death list gains the coverage columns and any pending
exception journal entry for the purged row.

## Consequences

- **The recovery promise is now conditional, and the product must say so
  everywhere it makes the promise.** That is a real reduction in the strength of
  ADR-0007's guarantee, accepted deliberately in exchange for giving users
  custody control, and paid for with disclosure rather than silence.
- Five distinct coverage populations replace one "not backed up" number, which
  touches the status bar, storage totals, the Settings backup panel, and the
  disaster-recovery surface.
- A new manifest schema version and its strict either-way validation add a
  forward-only migration and a restore path for placeholder rows.
- Publishing a verified manifest generation before each remote deletion costs
  one extra provider round trip per exception batch, which is the price of
  never leaving the newest generation pointing at bytes that are gone.
- The verified-local prerequisite makes excluding an offloaded photo a download
  operation with real bandwidth cost, surfaced before the user commits.
- Shared-byte custody means "remove cloud copy" is sometimes correctly refused
  at the blob level while still honoring the row-level choice — an outcome the
  UI must explain rather than hide.
- **Revisit when:** per-collection or rule-based coverage policies are wanted
  (this ADR decides per-photo and bulk-selection only); or when a provider
  arrives whose deletion semantics cannot satisfy §2 step 4, at which point
  `provider-unsupported` stops being a corner case and needs its own product
  shape.
