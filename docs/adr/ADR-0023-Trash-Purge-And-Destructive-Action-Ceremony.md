# ADR-0023: Trash, Permanent Purge, and the Destructive-Action Ceremony

## Status

Accepted 2026-07-19 on issue [#534](https://github.com/qwts/photos/issues/534)
(proposed and owner-accepted the same day; any section may still be amended by
owner veto before its implementing code lands). This ADR closes the deletion
semantics [ADR-0005](./ADR-0005-Library-Data-Model.md) explicitly deferred
("soft-delete/restore semantics arrive with M10"), ratifies the purge custody
shipped by #120/#121, and generalizes
[ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md)'s ceremony
discipline and [ADR-0010](./ADR-0010-Cloud-Restore-Staging-And-Atomic-Activation.md)'s
explicit destructive authorization into a contract for **every** destructive
surface. It extends ADR-0005, [ADR-0007](./ADR-0007-Backup-Format-And-Offload.md),
[ADR-0009](./ADR-0009-Cloud-Recovery-Bootstrap-And-Manifest-V2.md), ADR-0013, and
[ADR-0018](./ADR-0018-Semantic-Search-And-Language-Model-Architecture.md); it
rewrites none of them.

Section map: §1–§3 govern [#534](https://github.com/qwts/photos/issues/534)'s
Trash language and retention surface, §4–§5 the purge custody and cloud
honesty, §6–§7 the ceremony contract and the destructive-action registry
(also binding on [#482](https://github.com/qwts/photos/issues/482) protected
Originals, ADR-0022's relocation cleanup UX, and every future destructive
surface).

**Amended 2026-07-23 by [#750](https://github.com/qwts/photos/issues/750)
(PR #758):** Tier D's "remote state destroyed" means destroyed **from
Overlook's custody** — the row, local bytes, and the app's claim on the
remote object are gone and unrecoverable through Overlook — but the provider
adapter MUST use the provider's recoverable deletion where one exists (Drive
trash 30 days, pCloud Trash 60 days, iCloud Recently Deleted 30 days), never
a permanent purge. The #741 incident is the reason: a deletion bug at the
adapter layer must be survivable through the provider's own retention. The
lingering object is ciphertext sealed under the library's keys, so provider
retention discloses no content; §5's honest sentence gains a clause saying
the encrypted copy remains in the provider's trash, recoverable only through
the provider, until that provider's retention expires. Purge remains Tier D
and its vocabulary is unchanged.

## Context

Deletion is the one operation whose _purpose_ is data loss, so it runs the
project's zero-data-loss philosophy inverted: every step before the last must
be reversible, and the last step must be willful, fully disclosed, and
auditable.

- **The code is ahead of the paper.** Soft delete/restore ships (#120;
  `src/main/db/photos-repository.ts:408-450`), permanent purge ships (#121;
  `src/main/library/purge-service.ts`), and a **30-day retention sweep is
  already live** at startup maintenance (`PURGE_RETENTION_DAYS = 30`,
  `purge-service.ts:12`, invoked from
  `src/main/library/startup-maintenance.ts`) — the code itself records "a
  fixed constant until a settings control is designed." No ADR governs any of
  it; ADR-0005 deferred the semantics and the deferral was never resolved.
- **The shipped purge order already encodes the house blast-radius rule.**
  DB row first, local blobs second (content-hash refcounted), remote last
  with retries — "nothing ever points at missing data"
  (`purge-service.ts:4-10`). Failures strand _extra_ copies (audited
  `ORPHAN-REMOTE` lines, retried on later purges), never a row that lies.
- **Confirmations are renderer-only today** ("destructive-confirmed in the
  renderer", `src/shared/ipc/channels.ts:427-431`) — a stale or buggy
  renderer could invoke `library:purge` with no ceremony. #534's acceptance
  explicitly requires enforcement against direct IPC.
- **#534 defines the words; no ADR defines the rules the words describe.**
  "Move to Trash", "Delete permanently…", and the confirmation contract need
  decided semantics behind them, or the copy promises behavior nobody
  ratified.

## Decision

### 1. Three tiers of destructive action, fixed vocabulary

Every destructive action belongs to exactly one tier, and its language is
fixed by tier (#534's language contract, elevated to ADR law):

| Tier                         | Meaning                                                          | Vocabulary                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **R — Reversible**           | Content moves to a recoverable state; bytes untouched            | **Move to Trash**, **Restore from Trash**                                                                                              |
| **M — Membership/structure** | Destroys structure, links, or registry state — never photo bytes | Object-specific: **Delete album**, **Remove from album**, **Remove library from list**, **Disconnect provider**, **Clear diagnostics** |
| **D — Irreversible**         | Photo bytes, keys, or remote state destroyed                     | **Delete permanently…**, **Empty Trash…**, destructive profile erase (ADR-0013's naming rules)                                         |

A Tier-R action is never labeled permanent; a Tier-D action is never reachable
through a generic "Delete"; a Tier-M action never implies content loss and its
ceremony must _say_ the content survives (ADR-0017 §5's "Remove never deletes
library contents" becomes the pattern for the whole tier).

### 2. Trash is the product surface of soft delete

- Renaming **Recently deleted → Trash** (#534) is ratified: the surface _is_
  a trash can and must present as one.
- Soft delete sets `deleted_at` and nothing else — no blob, ledger, or
  membership changes (`photos-repository.ts:408-430`); Restore returns the
  row intact (`:433-450`). This stays the whole contract: Trash is a marker,
  never a move.
- Soft-deleted photos remain in cloud backup with their deleted state
  (ADR-0009 unchanged) — the Trash survives disaster recovery.
- Protected-domain photos keep their own delete/restore inside the protected
  domain (ADR-0013 unchanged); they never appear in the ordinary Trash.

### 3. Retention — 30 days ratified, but the fuse must be visible

- The shipped default — auto-purge after 30 days — is **ratified**, matching
  the universal photos-app trash contract. What makes scheduled irreversible
  deletion acceptable under the zero-loss philosophy is **disclosure, not
  absence**: the Trash view states the policy and shows **per-item time
  remaining**, and Move-to-Trash copy names the window. A trash can with an
  incinerator schedule must show the fuse.
- The retention sweep is the same code path and custody as a manual purge
  (`purgeExpired → purge`, `purge-service.ts:91-99`), cancellable at photo
  boundaries, drained per ADR-0017 §4's table.
- The recorded settings-control debt is decided in shape: one bounded control
  — **Off / 7 / 30 / 90 days**, default 30 — where Off means a manual-only
  Trash that never self-empties. Implementation belongs to #534 or a
  follow-up it files; no other knob (no per-photo retention override in
  ordinary Trash).
- Never purge on disk pressure, never on uninstall, never beyond the window —
  retention is the **only** automatic path to Tier D, and it only ever fires
  on items whose fuse was visibly burning.

### 4. Purge custody — the row-first order is ratified as the honesty invariant

- Order (ratifying `purge-service.ts:53-88`): **DB row → local blobs
  (content-hash refcounted — deleted twins keep their bytes until their own
  purge) → remote blob** (3 attempts with backoff; `not-found` counts as
  success; final failure audited as `ORPHAN-REMOTE` and retried by later
  purges, never silently forgotten).
- The invariant behind the order, now law: **a purge failure at any point may
  strand extra copies — audited, repairable orphans — but must never leave a
  reference that claims data exists when it does not.** Blast radius always
  points toward surplus data, never loss or lies. (Same direction as
  ADR-0022's two-verified-copies end state.)
- The Trash is a mandatory airlock: a live row can never be purged
  (`photos-repository.ts:667-690` guards purge to soft-deleted rows). A
  "Delete permanently" issued on a live photo passes through soft-delete then
  purge mechanically — the airlock is structural, not a UX convention.
- Everything derived dies with the row: thumbnails, FTS rows, embeddings
  (ADR-0018 — same transaction as `purgeRow`). Every future derived store
  (edit variants #496, face data #285) must name its row in this list at
  design time, or it is a leak.

### 5. Cloud coupling and the honest sentence

- Per-photo purge **includes** the remote ciphertext blob — a user purging a
  photo means gone everywhere, and the ceremony (§6) discloses the cloud
  outcome rather than asking twice. Library-level destructive erase keeps
  ADR-0013's stricter rule (remote deletion is a _separate_ confirmation) —
  the blast radius difference justifies the ceremony difference.
- Purge owes and pushes a fresh manifest generation (`purge-service.ts:81-85`).
  ADR-0007 retains N=2 previous generations whose encrypted manifests may
  still _name_ the purged photo (metadata: filename, size, content hash)
  until they rotate; their blob references dangle, which correctly makes them
  ineligible restore fallbacks under ADR-0010's validation. The honest
  user-facing sentence is therefore: **"Cloud copy removed from the backup
  now (or flagged and retried if unreachable); the provider retains the
  encrypted object in its own trash until its retention expires (#750
  amendment); encrypted records naming this photo can persist in up to two
  older backup snapshots until those rotate away."**
  #534's "reports local/cloud outcomes honestly" is implemented with exactly
  this honesty, including surfacing `remoteFailures` in the result — a purge
  with stranded remote copies never reports as fully clean.
- Per-photo cloud retention controls (#506) change the _disclosure set_ (which
  copies exist to enumerate), not this custody order.

### 6. The ceremony contract — and authorization moves below the renderer

- Every Tier-D action requires a ceremony that: names the object or exact
  count; enumerates the side-effect set (local originals, derivatives,
  sidecars, metadata, cloud copies, structure); states plainly that it cannot
  be undone; names the partial-failure behavior (audited orphans, retry); and
  carries a destructive button whose label matches the action verb. Tier-M
  ceremonies must state what _survives_. High-impact Tier-R bulk actions may
  confirm, but the copy must say restoration is possible. Protected Originals
  keep #482's stronger ceremony.
- **Destructive authorization is enforced in the main process**, generalizing
  ADR-0010's destructive-authorization boundary. A renderer-provided static
  acknowledgment is request metadata, not authorization: renderer code and an
  injected script can reproduce it. Every user-initiated Tier-D request is
  therefore confirmed by a trusted main-process prompt bound to the exact
  object snapshot, and main refuses the operation when that prompt is denied.
  Automated retention remains the separately governed non-user-initiated path.
- Localization: destructive confirmations never ship unreviewed machine
  translation (ADR-0020's ruling, cited here because this is the surface it
  exists for).

### 7. One destructive-action registry

All destructive surfaces — buttons, context menus, menu bar, shortcuts,
dialogs, toasts, accessibility names — are driven from a single descriptor
registry (a `src/shared` module): each descriptor declares its tier, verb,
object naming, side-effect set, and ceremony level. #534's copy audit becomes
the act of populating it; Storybook ceremonies and E2E enumerate it, so an
unregistered destructive action is structurally visible in review and a
registered one is automatically tested. Known members at ratification:
photo Trash/restore/purge and Empty Trash (§2–§4), Delete album / Remove from
album (photos survive — say so), Remove library from list (ADR-0017 §5),
Disconnect provider (ADR-0011), Clear diagnostics (ADR-0021), destructive
profile erase (ADR-0013), relocation source cleanup and both-copies retry
(ADR-0022 §4).

## Consequences

- **Easier**: #534 becomes implementation of a decided contract instead of a
  negotiation; the shipped purge engine is already §4-compliant (this is
  ratification, not rework); the descriptor registry gives the copy audit,
  Storybook, and E2E one enumerable source of truth.
- **Harder**: authorization plumbing for Tier-D channels touches the IPC
  contract; per-item countdown needs the Trash view to compute remaining time
  from `deleted_at`; the registry is only as honest as review keeps it — an
  unregistered destructive surface is the new failure mode to watch for.
- **Deferred, with owners**:
  - The retention settings control (Off / 7 / 30 / 90, default 30) — implemented
    by [#606](https://github.com/qwts/photos/issues/606), the required #534 follow-up.
  - Forced manifest-generation rotation ("scrub cloud history now") — a new
    issue if ever wanted; until then the §5 honest sentence is the contract.
  - Per-photo cloud retention interplay — [#506](https://github.com/qwts/photos/issues/506).
- **Revisit when**: edit variants (#496), face data (#285), or sharing land —
  each adds rows to §4's derived-death list and entries to §6's side-effect
  disclosure set, and must amend this ADR's lists in the same change.
