# ADR-0034: On-Device Face Grouping and Biometric-Derived Data

## Status

Accepted 2026-07-29 on
[#795](https://github.com/qwts/overlook/issues/795). This ADR governs
[#285](https://github.com/qwts/overlook/issues/285) and its implementation
children, and reuses the inference substrate delivered by
[#391](https://github.com/qwts/overlook/issues/391) rather than adding a second
one. It extends
[ADR-0004](./ADR-0004-Encryption-And-Key-Management.md),
[ADR-0005](./ADR-0005-Library-Data-Model.md),
[ADR-0006](./ADR-0006-Media-Processing.md),
[ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md),
[ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md),
[ADR-0018](./ADR-0018-Semantic-Search-And-Language-Model-Architecture.md),
[ADR-0021](./ADR-0021-Opt-In-Crash-Diagnostics-Privacy-Boundary.md),
[ADR-0023](./ADR-0023-Trash-Purge-And-Destructive-Action-Ceremony.md),
and
[ADR-0031](./ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md); it
rewrites none of them.

Section map: §1 the shared runtime and model assets; §2 what is stored and how
it is encrypted; §3 the indexing lifecycle; §4 grouping, and why user
corrections are structurally durable; §5 consent, retention, deletion, and app
lock; §6 backup and restore; §7 the privacy boundary and threat model; §8
fixture licensing and performance budgets.

Implementation may choose table, module, and channel names. No child issue may
change the storage classification in §2, the correction-durability rule in §4,
the backup split in §6, or the privacy boundary in §7 without an ADR amendment.

## Context

Face grouping is the feature most able to damage this product's privacy
position, and the one whose derived data is hardest to take back. A face
template is a biometric identifier; a group label is the name of a third party
who never agreed to be catalogued; and both are inferred by a model that will
be wrong often enough that users will correct it.

The ground has also shifted since #285 was written:

- **The ML substrate exists.** #391 shipped `src/main/embedding/` — an
  onnxruntime-node worker with a one-worker-by-construction pool
  (`embedding-pool.ts`), cooperative retirement around uninterruptible native
  calls, a committed model manifest with per-asset SHA-256 and a `license`
  field, download-on-enable asset delivery, and int8 vectors in a `vec0` table
  inside the SQLCipher database. Building a second pipeline beside it would
  duplicate the hard parts — teardown, memory bounds, asset verification — and
  would compete with it for the same CPU.
- **ADR-0018 §8 already binds the privacy invariants** that face data must
  satisfy: encrypted at rest, per-library, purged with the photo, invisible to
  protected-domain content, and absent from everything that leaves the device.
- **ADR-0023 §4 requires every derived store to name its row in the purge death
  list at design time**, and explicitly names face data (#285) as a future
  member that must amend the list.
- **Reindexing is the correction-eating failure mode.** Any design where
  clustering output _is_ the stored grouping will lose user merges, splits, and
  names the first time a model version changes. That is not a bug to fix later;
  it is a schema decision to get right now.

## Decision

### 1. One inference substrate, extended — not a second pipeline

The shipped embedding worker is generalized into a **model registry over the
existing pool**: sessions are keyed by model id, at most one model runs at a
time, and sessions are evicted LRU under an explicit RSS ceiling. Face
detection and face embedding are two more registered models, not a new pool
and not a new worker file's worth of lifecycle. ADR-0018 §5's **cancel**
teardown classification and the cooperative-retirement mechanics apply
unchanged, because they exist for exactly this hazard.

Two models are needed and are pinned by a measured spike at the start of
implementation, with the criteria fixed here rather than the checkpoints
guessed now:

- a **face detector** producing bounding boxes and enough landmarks to align a
  crop, and
- a **face embedder** producing a fixed-dimension vector in an identity space.

Selection criteria: CPU-only throughput sufficient to index a 200K-photo
library within the §8 budget on the dev baseline machine; a permissive,
recorded license for both weights and training provenance; a documented
demographic-performance evaluation from the publisher, because a detector that
fails unevenly across skin tones is a product defect and not merely a metric;
and int8 quantization without unacceptable quality loss on the §8 fixture. The
pinned choice and its SHA-256 go into the committed manifest.

Asset delivery follows ADR-0018 §3 exactly: not bundled, not fetched on first
run, downloaded only on explicit enable, every file verified against the
committed SHA-256 before load with delete-and-fail-loud on mismatch, cached
per profile under `userData/models/<model-id>/`. Models are app assets, contain
nothing user-derived, and survive library switches.

The input is the **mid-size derivative** (ADR-0006), decrypted and decoded in
memory. Originals are never re-decoded for face work and plaintext pixels never
touch disk.

### 2. Storage: crops are cache, embeddings and assertions are data

Three distinct classes, deliberately not one:

**Face crops are a regenerable cache, not custody.** A crop is derivable from
the mid-size derivative and the recorded box, so it lives in the encrypted
derivative store under its own AAD-bound derivative kind, keyed by
`(original asset, variant revision, detector version, face id)`. It may be
evicted under a byte budget and rebuilt on demand, and deleting the whole crop
cache loses nothing. This is ADR-0031's presentation-cache posture applied to
the most sensitive derivative in the product: the smallest biometric footprint
on disk that still supports a review UI.

**Detections and embeddings are derived data inside the library database.**

- `faces` — face ULID, the ADR-0031 original asset and variant it was detected
  in, the box and landmarks in normalized oriented coordinates, detector id and
  version, a quality score, and detection time.
- `face_embeddings` — a `vec0` table alongside `photo_embeddings`, int8, unique
  on `(face_id, model_version)`.
- `face_groups` — group ULID, optional label, label time, hidden flag, and
  merge/split provenance.

All of it is inside the SQLCipher database, so it inherits encryption at rest,
per-library isolation, transactional purge, and WAL crash-safety by
construction — the same four reasons ADR-0018 §4 put vectors there.

**Assertions are user-authored records, and are the only face data that is not
re-derivable** (§4).

Migrations are forward-only. A detector or embedder version bump adds rows
under the new version and retires the old ones once the sweep completes; it
never drops a face row that an assertion references.

### 3. Indexing is incremental by construction and bounded by policy

The queue is a query, not a journal, exactly as ADR-0018 §5 established:
photos in `ordinary_visible_photos` with no `face_scan` row for the current
detector version, then faces with no embedding row for the current embedder
version. A crash or teardown loses at most the in-flight item and the next
sweep finds it again.

Scheduling reuses the shipped rules rather than inventing new ones: a
StartupMaintenance-style tracked sweep; an after-import trigger; **pause while
an import batch or backup run is active**, because import throughput is a
ratchet; **pause on battery, resume on AC**. Face indexing and semantic
indexing share one pool and therefore never run concurrently — face work
yields to semantic work when both are pending, so enabling faces cannot
regress search-index freshness.

Progress, pause/resume, and cancellation cross the typed IPC registry with the
existing progress-event pattern and surface in the status bar and Settings.
Disabling the feature cancels the in-flight job immediately and drops the
queue.

Clustering is a **third, separately bounded pass**. New embeddings are assigned
incrementally to existing groups by threshold, which is cheap and keeps the
review UI live during a first index. A full re-cluster is an explicit
operation — user-triggered, or automatic after a model-version bump — and is
constrained by §4.

### 4. Automatic clustering proposes; user assertions constrain

This is the section that makes "corrections are durable" a structural property
rather than an intention.

Grouping is two layers. The lower layer is the clusterer's output, which is
disposable. The upper layer is an **append-only assertion log** of things the
user has told the product:

- `same-person(face, face)`
- `not-same-person(face, face)`
- `is-person(face, group)`
- `not-a-face(face)`
- `label(group, name)`

Every clustering run — the incremental pass and any full re-cluster, including
one triggered by a model upgrade — is **constrained**: it must produce a
grouping that satisfies every live assertion. Clustering may split and merge
freely where the user has said nothing, and may never contradict an assertion
where they have. A set of assertions that cannot all be satisfied is surfaced
for review with the conflicting statements named; it is never resolved
silently by the algorithm, and never by discarding the older assertion.

Merge and split are therefore not destructive edits to a group table. Merging
records `same-person` assertions and a merge provenance entry; splitting
records `not-same-person` assertions and creates new group ULIDs that retain
their lineage. Group identity is a stable ULID so a name survives every
re-cluster beneath it. Undoing a correction retracts the assertion — an
append-only retraction record — rather than deleting history.

Naming a group is a `label` assertion and is per library. A group with no
label is unnamed, never "Unknown Person": the product does not assert identity
it was not given.

Purge interaction: ADR-0023 §4's derived-death list gains `faces`,
`face_embeddings`, face crops, and group membership for the purged photo, all
removed in the same transaction as `purgeRow()`. Assertions referencing a
deleted face are **tombstoned, not deleted**, so a re-import of the same photo
does not resurrect a correction the user made about bytes that are gone;
re-detection produces a new face id and starts unconstrained.

### 5. Consent, retention, deletion, and app lock

The Privacy setting is **off by default** and stays **disabled with a stated
reason** until its prerequisites are met — the ADR-0018 honest-setting standard,
applied so the control never appears functional before it is.

Enabling requires explicit opt-in whose copy states, factually and without
marketing: that faces are detected and grouped **entirely on this device**;
that model files of a named size download once; the estimated local storage
cost; that the feature creates **biometric-derived data** about the people in
the photos; and that it can be turned off and the derived data deleted at any
time. The copy states what the product does and does not make legal claims
about how that data is classified where the user lives.

Disabling stops work immediately (cancel class, §3) and offers deletion in the
same flow. Declining deletion keeps existing data and does no new work — a
state the UI must show plainly rather than treating "off" as "gone".

**Delete face data** is a single Tier D action under ADR-0023 §6, entered in
§7's destructive-action registry. Its ceremony names the exact counts of faces,
groups, and named groups; enumerates the side-effect set as detections,
embeddings, crops, groups, labels, and assertions; states that it cannot be
undone; and states that photos themselves are untouched. Deleting one named
group is a narrower Tier D with the same shape.

App lock (ADR-0013) releases face data with everything else: plaintext crops
and embeddings are zeroized, indexing stops, and no face surface renders while
locked. **Protected-domain photos are never detected and never embedded** — the
indexing surface is `ordinary_visible_photos`, and a photo moving into a
protected album has its faces, embeddings, and crops removed in the same
migration transaction that hides it, exactly as ADR-0018 §4 requires for
semantic embeddings. A face template is a content fingerprint; leaving one in
an unlocked index would leak protected content.

### 6. Backup splits along the re-derivable line

Derived face data — detections, embeddings, crops — is **not** in the backup
manifest. It is re-derivable from photos the manifest already carries, it would
add meaningful bytes to every generation, and face metadata must never be
mandatory for photo recovery.

User assertions and labels are **not** re-derivable, so they are backed up: a
small encrypted **face-corrections document**, sealed like any other manifest
object, containing the assertion log and group labels keyed by stable identity.
Because assertions reference face ids that a fresh index will not reproduce,
the document also records, per assertion, the photo identity and the normalized
box that produced each face, so restore can re-anchor a correction to a
newly-detected face by geometric match.

Restore therefore reconstructs the library first, and replays corrections
against the fresh index as it builds. An assertion that cannot be re-anchored —
its photo is gone, or no face is detected where one was — is retained as
**unanchored** and surfaced for review, never dropped and never guessed onto
the nearest face.

Restoring into a profile that has face grouping disabled restores the
corrections document and leaves it dormant. It is not a reason to enable a
privacy feature on the user's behalf.

### 7. Privacy boundary and threat model

**Face data is pinned private.** It never crosses a boundary: not export, not
XMP or any sidecar region, not interop, not diagnostics (ADR-0021), not a
language-model request — ADR-0018 §7's exhaustive list of what may leave the
device is unchanged by this ADR and gains nothing — and not any sharing
surface. No cloud face recognition, no identity inference from external
services or social graphs, no transmission of group data. There is no setting
that widens this.

Labels deserve their own sentence, because they are the part users
underestimate: a label is the name of another person, recorded by someone else,
without that person's involvement. Overlook stores it locally, never transmits
it, and never writes it into a file that leaves the library.

**Protects against:** the backup provider and anyone with provider credentials
(face data is not uploaded, and the corrections document is ciphertext under
the library key); disk theft or imaging; other OS users without the keychain
session; a network observer, because there is nothing to observe after the
one-time model download.

**Does not protect against:** a compromised OS or session while the app is
unlocked, where keys and plaintext crops are in process memory; a user who
deliberately exports a photo containing a face, which is an ordinary photo
export and always was; inference by anyone with access to the unlocked
application.

**Deliberately not built:** cloud recognition, cross-library or cross-user
identity linking, suggestion of identities from contacts or any external
source, and any surface that shares biometric group data.

### 8. Fixtures, licensing, and performance budgets

**No real biometric fixture enters the repository without a recorded license
and consent basis.** Test images carry a fixture provenance manifest in the
shape of the existing model manifest's `license` field: source, license, and
the consent basis under which the depicted people's images may be redistributed.
The default is synthetic or explicitly-licensed-for-redistribution imagery, and
the correctness suite is built so that detector and embedder behavior —
empty results, multiple faces, corrupt model, cancelled run, model-version
bump, constrained re-cluster — is testable without any real face at all.
Retrieval-quality measurement runs against an out-of-repo licensed evaluation
set, and only the **results** are committed, never the images.

Budgets enter `tests/perf/budgets.ts` at the 200K fixture as ratchets, each set
from the first honest measurement at or under its ceiling and then only ever
tightened (ADR-0001 discipline):

- detection throughput, in photos per second, on the dev baseline CPU;
- embedding throughput, in faces per second;
- incremental cluster-assignment time per new face, and full re-cluster time at
  the fixture's face count;
- the existing main-process RSS ceiling, unchanged and shared — face work must
  fit inside it, not raise it;
- non-regression on the existing import-throughput and search-latency ratchets
  while face indexing runs.

## Consequences

- **Easier:** the pool, asset verification, teardown classification, encrypted
  vector storage, and purge invalidation all already exist; face grouping adds
  models and tables rather than lifecycle machinery.
- **Harder:** constrained re-clustering is more expensive and more complex than
  re-running a clusterer, and the assertion layer adds a schema and a conflict
  UI. That is the price of never silently discarding a user's correction, and
  it is worth paying.
- **Harder:** two derived stores now share one worker, so scheduling fairness
  between semantic and face indexing becomes a real design surface with a
  stated rule (§3) rather than an emergent one.
- The backup split means a restored library re-indexes faces from scratch while
  replaying corrections, so first-run cost after a disaster recovery is higher
  and must be disclosed in the restore flow.
- The product acquires a standing obligation it did not have: it holds
  biometric-derived data about people who are not its users, and every future
  boundary — a new export format, a new interop target, a new sharing surface —
  has to answer §7 before it ships.
- **Revisit when:** an on-device model makes per-face quality good enough that
  the threshold-based incremental assignment in §3 can be replaced with
  something better; or when a platform offers a system face API whose custody
  terms are auditable, at which point §1's pinned-model decision is worth
  re-opening rather than assumed.
