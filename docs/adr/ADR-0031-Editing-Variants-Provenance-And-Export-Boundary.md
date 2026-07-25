# ADR-0031: Editing, Variants, Provenance, and Export Boundary

## Status

Accepted 2026-07-25 on
[#790](https://github.com/qwts/overlook/issues/790). This ADR governs
[#493](https://github.com/qwts/overlook/issues/493),
[#495](https://github.com/qwts/overlook/issues/495),
[#496](https://github.com/qwts/overlook/issues/496), and
[#497](https://github.com/qwts/overlook/issues/497), and supplies the payload
boundary required by
[#490](https://github.com/qwts/overlook/issues/490). It extends
[ADR-0004](./ADR-0004-Encryption-And-Key-Management.md),
[ADR-0005](./ADR-0005-Library-Data-Model.md),
[ADR-0006](./ADR-0006-Media-Processing.md),
[ADR-0014](./ADR-0014-Image-Trail-Bidirectional-Interoperability.md),
[ADR-0015](./ADR-0015-Deterministic-Reviewed-Sync-Journals.md),
[ADR-0023](./ADR-0023-Trash-Purge-And-Destructive-Action-Ceremony.md),
[ADR-0025](./ADR-0025-Encrypted-Activity-History-And-Capability-Aware-Undo.md),
and
[ADR-0026](./ADR-0026-Video-And-Animated-Media.md). It rewrites none of their
security, custody, deletion, or original-preservation guarantees.

Implementation may choose table and service names, but no child issue may
change the identities, ordering, compatibility reporting, evidence tiers,
reference ownership, or export boundary below without an ADR amendment.

## Context

Overlook currently treats one `photos` row, one immutable original, and one
pair of regenerable thumbnails as the same user-visible identity. That model
cannot safely represent persistent edits or multiple presentations of one
original:

- changing the original would break its content hash, backup identity, and the
  promise of byte-identical export;
- treating a variant as an ordinary duplicate would either copy bytes or let
  purging one row delete bytes another row still needs;
- imported XMP and AAE companions can carry edit instructions, but the raw
  sidecar and Overlook's normalized interpretation have different custody and
  compatibility needs;
- provenance assertions describe particular bytes. Copying an original's
  assertion onto a rendered derivative would make a false claim;
- "export edited photo" is ambiguous unless the product distinguishes rendered
  pixels, untouched bytes plus interoperable instructions, and untouched bytes
  alone.

The cluster needs one contract before storage, renderer, provenance, or export
work begins.

## Decision

### 1. Three identities: original asset, variant, and presentation

An **original asset** owns one immutable imported byte sequence, its plaintext
content hash, encrypted blob custody, imported companion sidecars, and evidence
whose subject is those bytes. Original bytes are never rewritten, recompressed,
or silently replaced.

A **variant** is a stable ULID that references exactly one original asset. It
owns user metadata, an edit head, and its place in albums, search, backup,
interop, Trash, and activity history. Import creates one root variant; Duplicate
creates another variant over the same original asset. Each variant is a
first-class photo in user-facing counts.

A **presentation** is the deterministic result of one variant revision and an
output specification. Grid thumbnails, lightbox images, video posters, and
baked exports are presentations. Cached presentations are encrypted,
metadata-stripped unless their explicit output policy says otherwise, and
regenerable; they never become original custody or proof that the original is
available.

The cache key includes the original asset identity, variant identity, edit
revision hash, rendering-pipeline version, and output specification. A cache
for one variant or revision must never satisfy another.

### 2. Edit stacks are immutable, versioned revision documents

Each saved edit creates an immutable revision document with:

- a format version and stable revision ULID;
- the parent revision ULID, or `null` for the empty root;
- an ordered list of typed operations with operation-versioned parameters;
- the author product, creation time, and optional imported-instruction
  reference;
- a canonical serialization hash used by presentation caches and backup
  integrity checks.

The minimum v1 operation order is:

1. interpret the source orientation without changing original bytes;
2. apply rotate and flip in oriented image space;
3. apply crop in normalized oriented coordinates;
4. apply tonal/color operations in their recorded order;
5. convert to the explicitly selected output color space and encode.

Operation order is data, not UI state. Implementations may fuse operations for
performance only when fixtures prove the same defined result. Unknown
operation types or versions are preserved but marked unsupported: Overlook may
show the untouched original or a previously authenticated cache, but must not
silently omit the operation and claim the result is current. Baking is blocked
until all operations are understood.

Save atomically advances the variant's edit head and dirties backup only when
the canonical document changes. Reset creates a new revision whose effective
stack is empty. Revert advances the head to a new revision derived from the
selected historical state; history remains append-only. A persistence failure
leaves the durable head authoritative and the renderer must reload it.

### 3. Variants share custody through durable references

The database is the source of truth for original ownership. Every live or
soft-deleted variant holds a foreign-key-protected reference to its original
asset. A cached integer reference count may accelerate storage accounting, but
it is never authoritative unless checked against those references in the same
transaction.

Variant metadata and edit history are independent. Presentation caches are
independent. Imported sidecars and byte-subject provenance belong to the
original asset; variant-authored declarations and lineage belong to the
variant or a particular revision.

The user-declared Original marker remains variant metadata under the
[Original Preservation Policy](../Original-Preservation-Policy.md). Duplicate
does not copy it. An unmarked sibling may be purged normally without affecting
a marked variant, while a marked variant retains its stronger deletion
ceremony. Original custody cannot reach its last-reference deletion while a
marked variant survives, so shared custody does not bypass that protection.

Variant-family operations are:

- **Promote:** choose the family representative for default navigation and
  naming. This is a reversible metadata change and does not move custody.
- **Merge:** allowed only between variants of the same original asset, through
  explicit field/edit conflict review that writes a new revision. It never
  deletes the source variant implicitly.
- **Detach:** not supported in the first implementation. Independence requires
  a new immutable byte sequence and custody identity; users can bake and import
  a new file. Merely assigning a second asset ID to identical shared bytes
  would falsely imply independent purge and recovery.

Exact-content duplicate review may propose a family relationship, but it never
auto-merges assets or variants. Protected albums remain a separate custody
domain; sharing an ordinary original across that boundary is forbidden.

### 4. Sidecars are preserved separately from normalized edits

Encrypted sidecar custody is owned by #484. ADR-0031 adds the interpretation
rule:

- imported sidecar bytes remain immutable companions of the original asset,
  with their own hash, media type, association role, and parser result;
- parsing may create a normalized edit revision, metadata fields, or provenance
  evidence, but never overwrites or substitutes for the raw companion;
- every normalized value records the source sidecar, parser/version, and
  compatibility status;
- reparsing appends a new interpretation. It does not rewrite prior history.

XMP is the writable interoperability target for operations covered by reviewed
round-trip fixtures. Unsupported operations produce a named loss report. AAE
is preserved and may be read when fixtures verify its meaning, but Overlook
does not author or rewrite proprietary AAE instructions without a separately
reviewed compatibility contract.

Imported instructions and Overlook-authored edits coexist as distinct
revisions. Reset or Revert changes the active Overlook presentation; it never
deletes imported sidecars.

### 5. Provenance uses evidence tiers and byte-exact subjects

Provenance is evidence, not a binary AI verdict. Overlook records these
non-collapsible tiers:

1. **Verified:** a cryptographic assertion validates for the exact subject
   bytes and a supported trust policy.
2. **Declared:** embedded or sidecar metadata names a generator or editing
   tool but is not cryptographically verified.
3. **Detected:** a reviewed watermark detector or heuristic reports a result
   with its model/version, confidence where meaningful, and documented limits.
4. **Unknown:** no supported evidence. Unknown never means human-created.

Raw assertions and declarations are encrypted with their subject. Validation
results record the subject hash, validator/trust-policy version, validation
time, and `valid | invalid | unverifiable` outcome. They are re-evaluated when
subject bytes, evidence, validator, or trust policy changes. Local validation
is the default; sending bytes or metadata to a network verifier requires
explicit opt-in.

An edit revision records lineage from its original asset, but the original's
verified assertion does not become a verified assertion about a baked output.
Unless Overlook later gains a separately governed signing identity, baked
outputs may carry a factual, unsigned declaration of Overlook processing and a
reference to retained source evidence. They must not copy credentials in a way
that makes them appear valid for changed bytes.

### 6. Export crosses the plaintext boundary in one declared mode

Every export records exactly one payload mode before bytes leave library
custody:

- **Baked:** render the selected variant revision to new bytes using explicit
  format, quality, dimensions, color-space, and metadata choices. The result is
  a derivative, not an Original, even when visually lossless.
- **Original plus sidecars:** export the byte-identical original, preserved
  compatible companions, and a generated XMP sidecar for the supported subset
  of the selected revision. The preflight names every unsupported or
  non-round-trippable operation and requires the user to continue with that
  loss or choose Baked. Nothing is silently omitted.
- **Original only:** export the byte-identical original and state that
  presentation edits and companion sidecars are omitted.

All modes use deterministic collision-safe names, stream bounded plaintext,
and remove partial plaintext on cancellation or failure. Metadata retention is
an explicit policy independent of edit mode. "Original" always means the
verified imported bytes, never the current presentation cache.

Portable encrypted packages under #490 wrap one of these modes; encryption
does not create a fourth semantic mode. Their manifest records export-scoped
asset/variant/revision identities, content hashes, sidecar roles, compatibility
losses, and provenance outcomes without leaking unnecessary private metadata.

### 7. Backup, restore, and interop preserve meaning before appearance

Backup manifests include original-to-variant references, current and retained
edit revisions, sidecar custody, variant metadata, and provenance evidence.
They do not include regenerable presentation caches as authoritative data.
Restore validates references and authenticated payloads before atomically
publishing a variant; a partial restore never exposes a variant whose original
or edit head is missing.

Interop uses stable variant identity and revision vectors in addition to the
original content hash. Unknown operations and namespaced evidence round-trip
without being applied. A receiver that cannot render an edit preserves it and
reports the variant as presentation-unsupported rather than flattening it.
Keep-both creates a second variant over the same original only after exact
content verification; different bytes create a different original asset.
Concurrent edit heads require explicit review under ADR-0015 and never resolve
by arrival order.

### 8. Purge and migration fail toward surplus data

Moving one variant to Trash does not affect its family. Permanently purging a
variant removes its metadata, edit revisions, lineage, and presentations. The
original asset, imported sidecars, and byte-subject provenance become eligible
for local and remote deletion only when the same transaction proves no
variant—including soft-deleted variants—still references them.

The purge death list in ADR-0023 therefore expands to variant metadata, edit
revisions, presentation caches, lineage, variant-subject provenance, and, at
last-reference deletion only, original sidecars and byte-subject provenance.
Failure may strand encrypted bytes or rows recorded as cleanup debt; it must
never leave a surviving reference to deleted custody.

The forward-only migration from the current schema:

- creates one original asset and one root variant for each existing photo;
- preserves the existing photo ULID as the root variant identity;
- preserves the existing content hash and encrypted blob as original custody;
- assigns an empty v1 edit revision without decrypting or rewriting the
  original;
- accepts legacy thumb/mid files only for that empty root revision, then moves
  to variant-and-revision cache keys on regeneration.

Old backup manifests restore as one root variant with an empty edit stack.
Newer manifests and edit documents are preserved when a reader cannot apply
them; original-only recovery remains available, while presentation baking
fails closed. No migration requires a whole-library plaintext rewrite.

## Consequences

- Originals remain byte-identical while edits, variants, and evidence become
  durable, independently reviewable data.
- Sharing one original saves space but makes reference integrity and
  last-reference purge part of the security boundary.
- Immutable revision documents make backup, conflict review, cache
  invalidation, and audit deterministic at the cost of retained history.
- XMP interoperability is intentionally narrower than Overlook's edit model;
  visible loss reporting replaces lowest-common-denominator editing.
- Provenance copy becomes more cautious: Overlook can report evidence and
  validation, but cannot infer human authorship or transfer trust to changed
  bytes.
- #493 implements §2 and the migration in §8; #496 implements §1, §3, and the
  purge additions in §8; #495 implements §5; #497 implements §4 and §6; #490
  consumes §6's package payload contract. Later semantic changes amend this ADR
  before code.
