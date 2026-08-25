# ADR-0009: Cloud Recovery Bootstrap and Backup Manifest v2

## Status

Accepted (2026-07-14 via merged
[PR #292](https://github.com/qwts/photos/pull/292), closing
[#289](https://github.com/qwts/photos/issues/289)). This ADR extends
[ADR-0007](./ADR-0007-Backup-Format-And-Offload.md) and
[ADR-0008](./ADR-0008-Recovery-Key-Format.md); it does not replace their blob,
offload, or recovery-file formats.

**Amended and accepted 2026-08-24 by
[#996](https://github.com/qwts/overlook/issues/996):** recovery-bootstrap
freshness is bound to the monotonic manifest path generation, never inferred
from `generatedAt`. OVRB v2, its bootstrap-first interruption relation, and the
conservative OVRB v1 restore migration are specified below.

## Context

ADR-0007 requires an encrypted, generation-numbered manifest that can rebuild
a library without the local database. The schema-1 implementation contains
only photo ID, content hash, byte size, file name, and key ID. It cannot
reconstruct library identity, complete display metadata, favorites, albums,
ordered membership, or database/schema compatibility.

There is also a key-bootstrap cycle. Manifest envelopes are sealed by the
active versioned library key. The password-encrypted recovery file from
ADR-0008 contains the master key, while the master-wrapped library-key records
live only in local `keys.json`. On a lost machine, the user has the key needed
to unwrap those records but not the records needed to resolve the manifest's
envelope key ID.

## Decision

**Remote layout gains one provider-neutral recovery object:**

```text
/Overlook/<library-id>/
  recovery/bootstrap.ovrb
  manifest/gen-<n>.ovlk
  blobs/<h2>/<hash>
```

The backup engine uploads and checksum-verifies
`recovery/bootstrap.ovrb` before publishing a manifest generation. Replacing
the bootstrap first is safe because its wrapped-key set is a rotation
superset: an interrupted run may leave an older manifest with newer wrapped
keys, never a newer manifest whose envelope key is unavailable. Manifest
generations retain ADR-0007's newest-two policy. Bootstrap and manifest bytes
must both pass provider checksum/size verification before the run reports the
manifest complete.

**Recovery-bootstrap format is `OVRB` version 1.** The binary framing is:

```text
magic "OVRB" (4) | version 0x01 (1) | nonce (12)
| AES-256-GCM ciphertext(JSON payload) | tag (16)
```

The encryption key is
`HKDF-SHA256(master, info="overlook cloud recovery bootstrap v1")`. The
header is GCM AAD. The authenticated JSON payload contains schema version,
library ULID, generation timestamp, and every versioned `keys.json` record:
key ID, creation time, active/retired state, and the data key already wrapped
by the master. Exactly one record is active and key IDs are unique. The outer
document is capped at 1 MiB. Neither the raw master key nor any unwrapped data
key is uploaded. The temporary in-memory master-key copy used to seal the
bootstrap is wiped after use.

**Manifest schema 2 is a strict, self-consistent snapshot.** It contains:

- schema version, library ULID, local database schema version, and generation
  timestamp;
- sorted key IDs in use and aggregate photo/byte/album totals;
- every recoverable photo's ID, original file properties, complete display
  metadata, favorite/deleted state, key ID, content hash, and canonical
  `blobs/<h2>/<hash>` reference;
- albums in stable position order with ordered photo membership.

The repository reads photos, albums, membership, key IDs, and totals in one
SQLite transaction. Live photos are included. Soft-deleted photos are included
only when their ledger state proves the original is already remote (`synced`
or `offloaded`); a local-only deleted original is not promised by a cloud
manifest. Album membership is restricted to included photos. Validators reject
unknown fields, malformed timestamps/hashes, duplicate IDs/positions/members,
missing key references, non-canonical blob paths, unknown album members, and
incorrect totals before upload or restore.

**Schema 1 remains readable but is not disaster-recoverable.** Parsers return
it as a typed legacy document with `restorable: false`. Existing schema-1
backups retain their supported backup/offload behavior; restore UI must not
claim they can reconstruct a complete library.

**Fresh-machine key resolution is explicit.** After the user opens
`overlook-recovery.key`, the recovered master decrypts the bootstrap and
authenticates/unwraps every library-key record. That resolver then opens the
retained manifest and referenced blob envelopes. Wrong masters, tampering,
malformed records, missing keys, and unsupported versions fail closed before
any local library is activated.

### Monotonic recovery publication binding (#996 amendment)

`generatedAt` remains authenticated display/audit metadata, but it carries no
freshness authority. Wall clocks can move backward, repeat a timestamp, or be
replayed. The monotonic publication identity is the positive safe-integer `N`
already encoded by `manifest/gen-N.ovlk`.

**New publications use OVRB version 2.** Its outer framing is the version-1
framing with byte `0x02`, and its domain-separated encryption key is
`HKDF-SHA256(master, info="overlook cloud recovery bootstrap v2")`. Its strict
authenticated JSON payload uses schema 2 and adds
`manifestGeneration: N` to the version-1 library ID, timestamp, and wrapped-key
set. An outer version and payload schema must match. Readers continue to
authenticate OVRB v1 with its original framing, KDF info, and strict schema;
writers never create a new v1 bootstrap.

**`N` is decided before either publication object is sealed or uploaded.**
After the ordinary completeness preflight succeeds, the engine lists the
remote manifest namespace, validates its generation numbers, and chooses one
greater than the highest advertised generation. It then:

1. snapshots current wrapped keys and nonce high-water state into OVRB v2
   bound to `N`, uploads it to `recovery/bootstrap.ovrb`, and checksum-verifies
   the replacement;
2. seals, uploads, and checksum-verifies the manifest at exactly
   `manifest/gen-N.ovlk`;
3. prunes retained generations only after both verified writes.

Computing `N` after a bootstrap write is forbidden: the bootstrap and manifest
would have no authenticated publication relation. Exhausted, malformed, or
non-safe generation numbers fail the publication before the bootstrap write.
The existing single-flight writer and provider verification contracts remain
in force.

**Discovery validates the advertised generation relation before decrypting a
manifest.** It authenticates the bootstrap, lists and numerically orders all
valid manifest paths, and uses the highest advertised generation even if that
manifest later proves corrupt or unsupported. For OVRB v2 exactly two states
are valid:

- `bootstrap.manifestGeneration === newest`: the publication completed; or
- `bootstrap.manifestGeneration === newest + 1`: the bootstrap-first write for
  the next publication completed but its manifest did not. The prior newest
  manifest remains recoverable because the bootstrap key set and nonce state
  are a newer superset.

A bootstrap generation below `newest` is an older replay and fails closed. A
gap greater than one means remote history is missing or mismatched and also
fails closed. Neither case may decrypt a candidate, fall back to a retained
generation, write staging state, or activate a local library. Clock rollback
and equal timestamps have no effect on this comparison.

Within a valid relation, retained-generation fallback is unchanged for corrupt
or unsupported manifests: candidates are tried newest first and a valid newer
candidate always wins. If a candidate encountered before any valid newer
candidate names an envelope key absent from the authenticated bootstrap,
discovery fails `wrong-key`; it does not silently substitute older state. An
unusable lower generation discovered after a valid newer candidate is skipped
and cannot override that candidate.

**OVRB v1 is readable but explicitly freshness-unproven.** Rejecting every
existing v1 backup would destroy the disaster-recovery path, while comparing
its timestamp would manufacture authority it does not have. Discovery may use
a v1 bootstrap under the existing authentication, library-ID, key, and
retained-candidate checks, including the fail-closed missing-key rule above.
Before any restored thumbnail, catalog, or later application write, restore
staging retires the v1 active data key and creates one fresh random active key.
The rotation is persisted before use, occurs exactly once across checkpoint
resume, and seeds the rebuilt database from the rotated key-store records.
Recovered objects retain their old key IDs and remain decryptable through the
retired records; no new nonce can be emitted under the freshness-unproven write
key.

Every restored database already carries manifest-publication debt. Therefore
the first successful backup after a v1 restore publishes OVRB v2 with the fresh
active key and current nonce high-water state. A trustworthy live library with
only v1 remote state repairs it through the same next-publication path. Until a
v2 pair lands, v1 remains a conservative compatibility path, never evidence of
monotonic freshness.

## Consequences

- A provider-neutral restore engine can discover compatibility and rebuild
  complete metadata without copying the old database or `keys.json`.
- Cloud recovery still requires two separately held authorities: provider
  credentials for ciphertext and the password-protected recovery file for the
  master key.
- The small bootstrap is rewritten and verified with each manifest generation;
  this adds one provider object operation but removes the key-resolution cycle.
- Retained manifests are forward-only versioned documents. A future schema
  adds a parser/migration path rather than weakening strict schema-2 checks.
- Full staging, blob download, atomic activation, cancellation/resume, and the
  fresh-profile/Settings workflow are delivered by
  [#288](https://github.com/qwts/photos/issues/288) and
  [#290](https://github.com/qwts/photos/issues/290). The live pCloud
  disaster-recovery contract remains
  [#291](https://github.com/qwts/photos/issues/291).

## Verification

- `tests/backup/backup-manifest.test.ts`: schema-1 classification; schema-2
  round trip and cross-record/path/time/order validation.
- `tests/backup/recovery-bootstrap.test.ts`: fresh-process key resolution;
  wrong master, tamper, temporary-key wiping, v1/v2 framing and schema
  dispatch, generation authentication, and legacy readability.
- `tests/backup/manifest-snapshot.test.ts`: transactional full-state snapshot,
  backed-up deleted state, local-only deleted exclusion, ordering, and empty
  library.
- `tests/backup/backup-engine.test.ts`: verified bootstrap-before-manifest
  publication and newest-two manifest retention.
- `tests/backup/restore-discovery.test.ts`: replay and generation-gap refusal,
  bootstrap-one-ahead interruption, clock independence, missing-key posture,
  and retained fallback ordering.
- `tests/backup/restore-engine.test.ts`: exactly-once v1 staging rotation before
  restored writes and v2 no-rotation behavior.
