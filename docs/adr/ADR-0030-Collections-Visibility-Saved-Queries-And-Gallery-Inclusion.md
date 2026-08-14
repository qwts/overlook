# ADR-0030: Collections, Visibility, Saved Queries, and Gallery Inclusion

## Status

Accepted 2026-07-30 on
[#788](https://github.com/qwts/overlook/issues/788). This ADR governs
[#505](https://github.com/qwts/overlook/issues/505),
[#514](https://github.com/qwts/overlook/issues/514),
[#494](https://github.com/qwts/overlook/issues/494), and
[#512](https://github.com/qwts/overlook/issues/512), and supplies the
structure that
[#515](https://github.com/qwts/overlook/issues/515) and
[#516](https://github.com/qwts/overlook/issues/516) consume. It extends
[ADR-0005](./ADR-0005-Library-Data-Model.md),
[ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md),
[ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md),
[ADR-0018](./ADR-0018-Semantic-Search-And-Language-Model-Architecture.md),
[ADR-0023](./ADR-0023-Trash-Purge-And-Destructive-Action-Ceremony.md), and
[ADR-0025](./ADR-0025-Encrypted-Activity-History-And-Capability-Aware-Undo.md);
it rewrites none of their custody, deletion, or isolation guarantees.

Section map: §1 collection identity and hierarchy; §2 visibility composition;
§3 the saved-predicate model; §4 sources and gallery inclusion rules; §5 scope;
§6 query, count, and pagination performance; §7 migration and boundaries.

Implementation may choose table, module, and channel names. No child issue may
change the composition rule in §2, the unknown-predicate posture in §3, the
unknown-dimension rule in §4, or the scope split in §5 without an ADR
amendment.

## Context

The library's organizing surface has not moved since schema v1. Sources are a
fixed five-value enum — `all | favorites | recent | offloaded | deleted`
(`src/shared/library/app-state.ts`, mirrored in the IPC registry) — and the
only user-created structure is a flat `albums` list with ordered
`album_photos` membership. Four issues now want to grow that surface at once,
and each of them makes a decision the other three depend on:

- #505 adds nesting, which means "album" stops being the only node type and
  the sidebar becomes a tree with ordering, collapse, and deletion semantics;
- #494 adds a per-collection visibility policy, which is undefined the moment
  a photo belongs to two collections that disagree;
- #514 saves filter sets as Smart Albums, which turns a transient UI query into
  persisted, versioned, migratable data that must survive restore;
- #512 adds derived sources and inclusion thresholds, which changes what "All
  Photos" even means and therefore what every count on screen is counting.

Two constraints bound all four. ADR-0005 forbids `OFFSET` pagination, so
anything that decides row visibility has to compile into a cursor-friendly
`WHERE` clause rather than a post-filter. And the product's honesty rule
applies with unusual force here: a gallery that quietly shows fewer photos than
the library holds is the same class of failure as a backup that quietly holds
fewer photos than it claims.

## Decision

### 1. One collection tree, with system sources outside it

User structure is a single `collections` table with `kind` in
`album | folder | smart`:

- **album** — an ordinary collection with explicit ordered membership in
  `collection_photos` (the existing `album_photos` shape, renamed forward);
- **folder** — holds other collections and never holds photos;
- **smart** — holds a predicate (§3) and never holds membership rows.

Each row carries a ULID, name, nullable `parent_id` that may only reference a
folder, `position` among its siblings, and its visibility policy (§2). Cycles
are rejected in the same transaction that writes a move. Nesting depth is
bounded, and the bound exists for a stated reason rather than taste: sidebar
virtualization and the recursive descendant query both degrade with depth, and
an unbounded tree makes the §6 budgets unprovable.

**Organizational tags on collections are a separate vocabulary from photo
keywords**, in their own table with no shared identifier. #505's requirement not
to conflate them is enforced by schema rather than by convention, because a
shared vocabulary would silently merge "albums I tagged _trips_" with "photos I
tagged _trips_" the first time either surface grew a join.

**Favorites, Recently imported, and Trash remain system sources, not
collections.** They cannot be moved into folders, renamed, deleted, or given a
visibility policy, and their semantics are fixed by the product rather than by
the user. Making them collections would invite a user to hide Trash from
themselves.

Deletion follows ADR-0023 Tier M and its rule that the ceremony must state what
_survives_: deleting a collection never deletes photos, and the copy says so.
A non-empty folder requires either an explicit destination for its children or
a recursive structure confirmation naming the exact counts of folders, albums,
and Smart Albums that will be removed. Photos are never among those counts.

Ordering is `position` within a parent, which is where #225's album
drag-and-drop reconciles; there is one ordering mechanism, not one per node
type.

### 2. Visibility composes by inclusion, and the toggle discloses it

Every collection carries `show_in_all_photos`, defaulting to true for existing
and new collections. A folder's setting is a **default for descendants that
have not set their own**; an explicit setting on a child wins over the
inherited one, and the UI shows which of the two is in force.

**Membership is what can remove a photo from All Photos, and only unanimously.**
A photo is in All Photos when it belongs to no collection at all, or when at
least one collection containing it is visible. Only a photo whose every
containing collection is excluded leaves the gallery.

The uncollected case is the base case, not an edge case: All Photos is every
non-deleted ordinary row today (`sourceWhere('all')` in
`src/main/db/photos-repository.ts`), album membership is an optional additional
filter, and most rows in a real library are unfiled. A rule phrased purely over
collections would empty the gallery of every newly imported photo.

When a photo belongs to several collections whose policies disagree,
**inclusion wins**: it remains in All Photos if any collection containing it is
visible.

That direction is chosen deliberately. #494 states that exclusion is
organizational metadata and not a security boundary — protected albums
(ADR-0013) are the privacy mechanism. Given that, the two candidate rules
differ only in their failure mode. Exclusion-wins lets a single tidying gesture
on one collection silently remove photos that another collection still
surfaces, which is the "quietly fewer photos than you have" failure this
project treats as a defect everywhere else. Inclusion-wins fails toward
visible, which is recoverable by looking.

The cost is that hiding one collection sometimes appears not to work, so the
disclosure is part of the decision, not a nicety: the collection's toggle shows
how many of its photos remain in All Photos because another visible collection
includes them, and offers to reach those collections.

Excluded contents remain fully available inside their own collection, in
explicit search, in Smart Albums that select them, in counts within the
collection, in export, and in backup. Exclusion changes one thing: membership
of the All Photos presentation.

### 3. Smart Albums are versioned predicates, compiled by the live query builder

A Smart Album stores a **typed predicate document**, never materialized
membership:

- a `predicate_version`;
- facet clauses — file type including specific RAW containers, megapixel range,
  camera, lens, location, tag/keyword, favorite, custody, availability, and
  source;
- boolean composition, with OR within an inclusive facet group and a
  user-selected composition across groups, recorded explicitly because #514
  forbids hiding boolean semantics from the user;
- sort order, and any inclusion-rule overrides the query needs (§4).

**One compiler serves both the live toolbar filters and saved predicates.** A
saved query and the equivalent live filter therefore cannot diverge, and a
Smart Album cannot acquire behavior the interactive UI does not have. Results
update as metadata changes because they are always evaluated, never cached as
membership.

Editing, duplicating, renaming, and deleting a Smart Album never touch photos;
deletion is Tier M with the survival statement. Predicate edits are recorded in
ADR-0025 activity history.

**Unknown predicate versions and unknown facets fail closed.** A document a
reader cannot fully understand is preserved unchanged, marked unsupported, and
rendered as an explanatory empty state naming what it could not evaluate. It is
never partially evaluated, because a Smart Album that silently drops a clause
returns a superset the user believes is exact — the same posture ADR-0031 takes
toward unknown edit operations.

### 4. Derived sources and gallery inclusion rules

**Unavailable is a derived source, not stored membership.** A photo is
Unavailable when a renderability probe fails — local bytes missing while the
row is not `offloaded`, decode failure, absent or unusable dimensions, or a
corrupt derivative — and the probe records a typed reason with the row. Because
membership is a query over that reason, repairing metadata or regenerating a
preview moves the item out of Unavailable immediately, with no restart and no
reindex. Each reason carries its own retry or repair action.

**RAW is a first-class derived source** over `file_kind`; the existing RAW
filter chip may remain as an accelerator over the same compiled clause.

All Photos inclusion is governed by explicit Settings policies:

- whether Unavailable items appear, **defaulting to appear** — a broken record
  the user cannot see is a record they cannot fix;
- a minimum-megapixel threshold with an explicit **None / show every size**
  option, which is the default;
- **unknown dimensions are never treated as zero megapixels.** A row whose
  dimensions are unknown is included regardless of the threshold and is shown
  with an unknown-dimension indicator. Treating unknown as zero would hide
  exactly the damaged records §4's Unavailable source exists to surface.

Inclusion rules affect presentation only. They never change custody, backup
coverage, offload state, album or Smart Album membership, export, or search
when the user asks for it explicitly. Every surface that applies an inclusion
rule states that a rule is active and shows the excluded count; an "All Photos"
that is silently filtered is forbidden.

### 5. Scope: semantics per library, view state per profile

Collection structure, membership, organizational tags, visibility policies,
saved predicates, and inclusion rules are **library data** — rows in the
encrypted database, carried by backup and restore, travelling with the library
across machines and registry moves (ADR-0017). A library that looks one way
here must look the same way after restore.

Sidebar collapse state, the last-selected source, and scroll position are
**per-profile view state** and are not backed up.

The split is a rule, not a case-by-case judgement: anything that changes _which
photos a surface shows_ is library data, and anything that changes _how the
chrome looks right now_ is profile state. Switching libraries must never
silently change what a gallery includes.

### 6. Queries, counts, and the composition flag

Keyset pagination remains mandatory (ADR-0005). Inclusion rules and predicates
compile into cursor-friendly `WHERE` clauses with covering indexes. Renderer
post-filtering is not an implementation option, because a page filtered after
the fact returns short pages and breaks cursors.

**Counts come from the same compiled predicate as the page query.** A count and
the page it labels can never be produced by different logic, and a count is
never obtained by materializing identifiers.

Visibility composition (§2) is maintained as a **transactional per-photo
`in_all_photos` flag**, defined to match §2 exactly:

```text
in_all_photos = (the photo has no collection memberships)
             OR (at least one containing collection is visible)
```

It defaults to true, and only unanimous exclusion clears it. The default
matters as much as the rule: a photo acquires the flag at import, before any
collection exists to speak for it, and any implementation that computes the
flag purely from memberships is wrong in the most common case.

Evaluating that expression per row at the 200K scale target requires a
correlated existence check that defeats the covering index and therefore keyset
pagination; the flag is the price of keeping the main gallery paginated. It is
written in the same transaction as any membership change, collection move, or
policy change that could affect it; it is rebuildable by a
StartupMaintenance-style sweep; and it is **never authoritative over the rows it
summarizes** — a detected mismatch rebuilds the flag rather than being trusted,
exactly as ADR-0031 §3 treats cached reference counts.

New budgets enter the 200K perf harness as ratchets, each set from the first
honest measurement at or under its ceiling and then only tightened: gallery
page latency with inclusion rules active, sidebar tree render and count refresh
at a large collection count, and Smart Album evaluation for a multi-facet
predicate. The existing search and import ratchets are non-regression
constraints.

### 7. Migration and boundaries

The forward-only migration:

- creates one `collections` row per existing album, `kind='album'`,
  `parent_id` NULL, preserving its ULID, name, and position;
- carries `album_photos` forward as `collection_photos` with membership and
  ordering intact;
- sets `show_in_all_photos` true for every migrated collection;
- backfills `in_all_photos` true for every photo;
- leaves the existing source enum and filter chips working unchanged, so the
  new sources are additive rather than a replacement.

**Protected albums are not nodes in this tree.** They remain the separate
custody domain ADR-0013 defines: they never appear as folder children, their
names and counts never leak into tree queries or placement UI while locked,
and protected photos never contribute to `in_all_photos` for the ordinary
gallery. A future "place a protected album in a folder" affordance needs its
own decision about what leaks while locked, and does not exist here.

Backup carries collections, membership, tags, policies, predicates, and
inclusion rules in the manifest as ordinary library data. Restore validates the
tree — parent references resolve, no cycles, positions unique among siblings,
predicates parse or are marked unsupported — before activation, and rebuilds
`in_all_photos` from the restored rows rather than trusting a restored flag.

## Consequences

- **Easier:** one node type with one ordering mechanism collapses three
  would-be hierarchies into a single tree; one query compiler means saved and
  live filters cannot drift; a derived Unavailable source needs no membership
  bookkeeping and repairs itself by definition.
- **Harder:** the `in_all_photos` flag is denormalization with a transactional
  writer and a rebuild sweep, and every future feature that can change
  membership or policy must remember to maintain it. That is a real ongoing
  cost, accepted because losing keyset pagination on the main gallery is worse.
- **Harder:** inclusion-wins composition will read as "the hide toggle didn't
  work" to some users, which is why the disclosure in §2 is part of the
  decision rather than a follow-up.
- Smart Albums become migratable persisted data with a fail-closed unknown
  path, so every future facet addition carries a version bump and a migration
  obligation.
- #505 implements §1; #494 implements §2; #514 implements §3; #512 implements
  §4; all four consume §5–§7. #515 and #516 build on §1's tree without
  amending it.
- **Revisit when:** collection counts or nesting depth make the §6 budgets
  unachievable and a different composition strategy is needed; or when a
  protected-album placement affordance is genuinely wanted, at which point §7's
  boundary needs its own leak analysis rather than a quiet relaxation.
