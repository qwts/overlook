# Overlook Library Format v1

## Status

**Descriptive, not normative.** This document was written by reading the
implementation at `abbb413` and probing a real database. Where it disagrees with
the code, the code is right and this page is a bug — fix it in the same PR that
changes the format.

It exists because until now the on-disk format was defined **only** by the
TypeScript implementation. That is a resilience gap independent of any port: a
backup nobody can decrypt from a second implementation has a single point of
failure. Written as a byproduct of
[Spike — Multi-Platform Port](./Spike-Multi-Platform-Port.md); tracked on
[#519](https://github.com/qwts/photos/issues/519).

Related decisions: [ADR-0004](./adr/ADR-0004-Encryption-And-Key-Management.md) (crypto and
custody), [ADR-0005](./adr/ADR-0005-Library-Data-Model.md) (layout),
[ADR-0008](./adr/ADR-0008-Recovery-Key-Format.md), [ADR-0013](./adr/ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md),
[ADR-0017](./adr/ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md), and
[ADR-0028](./adr/ADR-0028-Remote-Custody-Binding-And-Custody-Safe-Disconnect.md).

## Conventions

- All multi-byte integers are **big-endian**. `u8`/`u32be` below.
- `‖` is byte concatenation.
- All symmetric encryption is **AES-256-GCM** with a **12-byte nonce** and a
  **16-byte tag**. Keys are always exactly 32 bytes.
- "base64" is standard base64 with padding. Several records additionally require
  **canonical** base64 — re-encoding the decoded bytes must reproduce the input
  string exactly.
- JSON is UTF-8, and in two records (§4.2, §10.2) **field order is
  significant** — see the trap in §12.

---

## 1. On-disk layout

A library is a single directory. It is self-contained except for custody
(§4.1) and the multi-library registry, which lives outside at
`userData/libraries.json` by design so a corrupt registry fails loudly rather
than self-healing.

```
<library>/
  library-id                    26-char ULID, bare, no wrapper, no newline
  library.db                    SQLCipher 4 (§9)
  library.db-wal, -shm          WAL sidecars
  library.lock                  advisory cross-instance lock (hostname + pid)
  master.key                    §4 — TWO possible forms
  master.key.pending            crash-safe staging for a master.key transition
  keys.json                     §5 — wrapped library keys
  app-lock.configured           6-byte marker, exactly "OVLK1\n"
  blobs/<h0:2>/<h2:4>/<hash>    originals, OVLK envelopes (§6, §7)
  thumbs/<h0:2>/<hash>.thumb    derivative, OVLK envelope   ← ONE level of fan-out
  thumbs/<h0:2>/<hash>.mid      derivative, OVLK envelope
  sidecars/<id0:2>/<photoId>/<hash>  companion files (#484), OVLK envelopes, PER PHOTO
  tmp/                          staging for atomic publish; safe to delete when idle
  ephemeral/                    decrypted-view custody; WIPED on every init()
  protected-blobs/              §10
  protected-tmp/
  import-journal.json
  <provider>-auth               backup provider tokens
  google-drive-import/
```

Note the asymmetry: **originals use a two-level hex fan-out, thumbnails use
one.** This is easy to get wrong and produces a store that looks fine until a
lookup misses.

Sidecar companions (#484) are custody **per photo**, not content-addressed
across the library: the path keys on the owning photo's ULID and the envelope
AAD context is `sidecar:<photoId>`, so a companion moved between photos (or
into the originals namespace) fails authentication. Identical companion bytes
owned by two photos are stored twice — sidecars are metadata-sized, and the
duplication buys purge-with-the-photo semantics with no shared-hash guard.
Rows live in `photo_sidecars` (schema v23) and CASCADE with the photo;
backup manifests (schema 6) list each companion at
`sidecars/<photoId>/<hash>` with its ciphertext digest.

`ephemeral/` is deleted and recreated on every `BlobStore.init()`. It holds
provider-fetched originals for viewing only and must never be treated as
durable.

## 2. Library identity

`<library>/library-id` holds a bare **ULID** matching `^[0-9A-HJKMNP-TV-Z]{26}$`,
written atomically (temp + rename). The file is authoritative and travels with
the directory; the registry only caches it. A value failing that pattern is
treated as absent and replaced — it never named a valid remote home.

The library id is bound into app-lock AAD (§4.2) and protected-photo AAD
(§10.2), so it is security-relevant, not just bookkeeping.

### 2.1 Registry custody hints

`userData/libraries.json` entries may contain a `custodyHints` array. Each
non-secret hint records `providerId`, `accountId`, `soleCustodyItems`, and
`soleCustodyBytes` for a remote authority used by that library. It lets a
profile-wide credential-removal preflight account for libraries whose encrypted
databases are closed. A non-zero hint is written before the first database
binding; it is cleared only after a verified zero recount. Hints contain no
tokens, remote paths, or encryption material.

## 3. Key hierarchy

```
        password ──scrypt──► password key ──┐
                                            ├─► unlock key U ──► master key M
   (or) OS keychain / recovery file ────────┘                          │
                                                                       │ AES-GCM unwrap
                                                                       ▼
                                              library keys #1..#N (32 bytes each)
                                                                       │
                                                                       ▼
                                                blob envelopes (§6), DB key
```

- **Master key M** — 32 random bytes, one per library. Never leaves the process
  in plaintext. Persisted only via §4.
- **Library keys** — 32 random bytes each, versioned by a `u32` id starting at 1,
  wrapped by M in `keys.json`. Exactly one is `active` (the write key); retired
  keys keep decrypting forever. Rotation is additive; there is no re-encrypt
  sweep in v1.
- The **database key** is a library key; the DB is opened in SQLCipher raw-key
  mode (§9).

## 4. `master.key` — two forms

Disambiguate by the first four bytes. If they are ASCII `OVLK`, it is the
app-lock record (§4.2); otherwise it is the keychain blob (§4.1). There is no
other discriminator.

### 4.1 OS keychain form — **not portable**

The output of Electron `safeStorage.encryptString(...)`: macOS Keychain, Windows
DPAPI, Linux libsecret. The plaintext inside is **base64 of the 32 master-key
bytes**, not the raw bytes.

This blob is bound to the Electron application's OS identity. **A second
implementation cannot read it**, and there is deliberately no plaintext
fallback — the key store refuses to open when the keychain is unavailable.

The two portable ways into such a library are the recovery key file (§8) or
configuring app lock, which rewrites `master.key` into the §4.2 form.

### 4.2 App-lock record — **portable**

```
"OVLK" ‖ UTF-8 JSON
```

Two nested slots: the password unwraps an **unlock key U**, and U unwraps **M**.
The indirection is what lets biometric unlock hold U under OS access control
without ever holding the password.

```json
{
  "version": 1,
  "libraryId": "<ULID>",
  "generation": 3,
  "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64, 16 bytes>" },
  "passwordSlot": { "algorithm": "AES-256-GCM", "nonce": "<base64, 12>", "ciphertextAndTag": "<base64, 48>" },
  "masterSlot": { "algorithm": "AES-256-GCM", "nonce": "<base64, 12>", "ciphertextAndTag": "<base64, 48>" }
}
```

- **KDF**: scrypt, N = 2^17 = 131072, r = 8, p = 1, 16-byte salt, 32-byte output.
  Costs ~128 MiB; implementations must raise any `maxmem` equivalent above that.
- `ciphertextAndTag` is **ciphertext ‖ tag** (32 + 16 = 48 bytes). Note this is
  the _opposite_ order from §5. See §12.
- **AAD** is an ASCII string, built per slot:
  ```
  OVLK|1|<libraryId>|<generation>|password|AES-256-GCM
  OVLK|1|<libraryId>|<generation>|master|AES-256-GCM
  ```
- `generation` is a positive integer that increases on every record replacement
  (configure, change password, recover, remove).

**Unlock:** derive the password key by scrypt over the record salt → open
`passwordSlot` with the password AAD → yields U → open `masterSlot` with U and
the master AAD → yields M.

**Freshness anchor.** A separate record `{libraryId, generation, recordHash}` is
kept in the OS credential store, where `recordHash` is the lowercase hex
SHA-256 of the **entire** `master.key` bytes including the `OVLK` magic. On
open, all three fields must match or the library reports `recovery-required`.
This is anti-rollback: it stops an attacker restoring an older record to
reinstate a revoked password.

**This anchor is a portability problem.** On desktop it is maintained by
shelling out to `/usr/bin/security`, `secret-tool`, or PowerShell DPAPI — and
process spawning is prohibited on every Apple mobile platform. A second
implementation must reimplement the anchor against Keychain/Keystore directly,
or the custody design must change. This is the open question in
[#519](https://github.com/qwts/photos/issues/519), and it is the single reason
this spec alone is not sufficient to build a mobile client.

`app-lock.configured` is a 6-byte marker containing exactly `OVLK1\n`. Its
presence with a missing or non-record `master.key` is what distinguishes
"never configured" from "configured and something is wrong".

## 5. `keys.json` — wrapped library keys

```json
{
  "version": 1,
  "keys": [
    { "id": 1, "createdAt": "<ISO 8601>", "status": "retired", "wrappedKey": "<base64>" },
    { "id": 2, "createdAt": "<ISO 8601>", "status": "active", "wrappedKey": "<base64>" }
  ]
}
```

Serialized with `JSON.stringify(file, null, 2)` and written atomically.

`wrappedKey` decodes to:

```
nonce (12) ‖ tag (16) ‖ ciphertext (32)
```

**The tag precedes the ciphertext here.** Encrypted with AES-256-GCM under **M**,
with **AAD = the key id as 4 big-endian bytes** and nothing else.

Invariant worth honoring: if `master.key` exists but `keys.json` is missing or
empty, **refuse to run**. Minting a fresh "KEY #1" would produce different bytes
under an id that existing envelopes already reference, silently orphaning every
blob.

## 6. Blob envelope (`OVLK`)

Used for originals, thumbnails, and — with a twist — protected blobs (§10.1).

### Header (17 bytes, once per file)

| Offset | Size | Field                                              |
| ------ | ---- | -------------------------------------------------- |
| 0      | 4    | magic `OVLK`                                       |
| 4      | 1    | format version, currently `1`                      |
| 5      | 4    | key id (`u32be`) — selects the library key from §5 |
| 9      | 8    | nonce prefix (random, per blob)                    |

### Chunks (repeating, until one carries the final flag)

| Offset | Size     | Field                                                   |
| ------ | -------- | ------------------------------------------------------- |
| 0      | 1        | flags (`u8`); bit 0 = final                             |
| 1      | 4        | total chunks (`u32be`) — **0 on every non-final chunk** |
| 5      | 4        | ciphertext length (`u32be`)                             |
| 9      | 16       | GCM tag                                                 |
| 25     | _length_ | ciphertext                                              |

- Plaintext chunk size is **4 MiB**. Decoders must reject a declared length above
  **8 MiB** (2 × chunk size) so a forged length cannot force unbounded buffering.
- A zero-byte plaintext still produces exactly one final chunk with a zero-length
  ciphertext. There is no empty-file special case.

### Nonce

```
nonce (12) = noncePrefix (8, from the header) ‖ chunkIndex (u32be, 4)
```

`chunkIndex` starts at 0. The random prefix means no cross-blob counter state is
needed.

### AAD (per chunk)

```
utf8(photoId) ‖ keyId (u32be) ‖ chunkIndex (u32be) ‖ flags (u8) ‖ totalChunks (u32be)
```

The `photoId` is variable-length UTF-8 with **no length prefix**, followed by
exactly 13 fixed bytes. `totalChunks` in the AAD matches the chunk header — 0
except on the final chunk.

This binds photo identity, key version, ordering, the end-of-stream marker, and
the declared length into every tag, so substitution, reordering, and truncation
all fail authentication rather than silently returning short data.

### Decoder obligations

- Reject unknown magic or a version other than 1.
- Reject any data after the final chunk.
- On the final chunk, verify `totalChunks == chunkIndex + 1`.
- Treat a stream that ends before a final chunk as **truncated and invalid** —
  never return partial plaintext.

Reading the first 9 bytes is enough to recover a blob's key id without
decrypting, which the store relies on when deduplicating.

## 7. Content addressing

- `contentHash` = lowercase hex **SHA-256 of the PLAINTEXT**, 64 chars.
- Originals: `blobs/<hash[0:2]>/<hash[2:4]>/<hash>`
- Thumbnails: `thumbs/<hash[0:2]>/<hash>.thumb` and `.mid`, where `<hash>` is the
  **original's** hash — derivatives are addressed by their source, not their own
  content, and there is only one level of fan-out.

Derivatives are 512 px (thumb) and 2048 px (mid) long-edge WebP, sRGB, with all
metadata stripped, per [ADR-0006](./adr/ADR-0006-Media-Processing.md).

**Publish protocol** — originals use no-replace semantics:

1. Stream plaintext through the envelope into `tmp/stage-<random>`, hashing the
   plaintext as it goes.
2. `fsync` the staged file.
3. `link()` it to its final path. `EEXIST` means these exact bytes are already
   stored — **keep the existing envelope** and report _its_ key id, because its
   AAD binds the original photo id. Overwriting would orphan that row's
   decrypts.
4. Remove the stage file, then `fsync` the destination **directory** so the entry
   itself is durable.

Thumbnails may be replaced (repair re-derives them); originals never are.

Restored blobs additionally **must** decrypt and re-hash to their claimed content
address before they count as present. A failed verification deletes the file.

## 8. Recovery key file (`OVRK`)

`overlook-recovery.key` is **exactly 81 bytes** (`RECOVERY_FILE_LENGTH`). Readers
should size-check before buffering — the runtime rejects any file of a different
size before reading it.

| Offset | Size | Field                              |
| ------ | ---- | ---------------------------------- |
| 0      | 4    | magic `OVRK`                       |
| 4      | 1    | version, currently `1`             |
| 5      | 16   | scrypt salt                        |
| 21     | 12   | GCM nonce                          |
| 33     | 32   | ciphertext (the sealed master key) |
| 65     | 16   | GCM tag                            |

- Key = scrypt(password, salt, 32) with **N = 2^17, r = 8, p = 1** — same
  parameters as §4.2.
- **AAD = the first 33 bytes** (offsets 0–32), i.e. the entire header: magic,
  version, salt, and nonce. A flipped version byte, salt, or nonce therefore
  fails the same tag check as a wrong password.
- Ciphertext ‖ tag are stored separately here (tag last), matching §4.2's order
  rather than §5's.

A wrong password and a tampered file are **deliberately indistinguishable** —
both fail the one tag check. Do not add an oracle that separates them.

Nothing about the password is stored anywhere, so it cannot be reset by
construction.

### Fingerprint

The UI's `9F2C·4A81·D0E7·5B3A` identifier is:

```
HKDF-SHA256(ikm = masterKey, salt = "", info = "overlook recovery fingerprint v1", L = 8)
```

rendered as uppercase hex in four 4-character groups joined by `·` (U+00B7).
It is deliberately **not** a direct hash of the key.

## 9. SQLCipher database

Opened with only these pragmas:

```
PRAGMA cipher = 'sqlcipher';
PRAGMA key = "x'<64 hex chars>'";   -- raw 32-byte library key
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

Everything else rides on defaults. **Measured** against the pinned driver
(SQLite3 Multiple Ciphers 2.3.5 / SQLite 3.53.2):

| Parameter               | Value                             |
| ----------------------- | --------------------------------- |
| `legacy`                | 0 → SQLCipher **4** format        |
| page size               | 4096                              |
| `kdf_algorithm`         | 2 → PBKDF2-SHA512                 |
| `hmac_algorithm`        | 2 → HMAC-SHA512                   |
| `kdf_iter`              | 256000 (bypassed in raw-key mode) |
| `fast_kdf_iter`         | 2 (derives the HMAC key)          |
| `hmac_pgno`             | 1                                 |
| `hmac_salt_mask`        | 0x3a                              |
| `plaintext_header_size` | 0                                 |

These are exactly the SQLCipher 4 defaults. The **first 16 bytes of the file are
the random salt** (equal to `PRAGMA cipher_salt`); the SQLite magic is _not_
present in plaintext.

Because the key is supplied raw, there is no passphrase KDF to reproduce — but
note the HMAC key **is** still derived from the raw key and the file salt using
PBKDF2 with `fast_kdf_iter = 2`. A compatible implementation must reproduce that.

Two independent routes exist for a second implementation: talk to stock
SQLCipher, or compile SQLite3 Multiple Ciphers (a plain C amalgamation that
builds everywhere) and eliminate the question. **Neither has been tested.** See
§13.

Schema, as of `abbb413`: **23 application tables** plus `schema_migrations`, and
a `photos_fts` **FTS5 virtual table** declared `content='photos',
content_rowid='rowid'` (external content) kept current by exactly **three
triggers** — `photos_fts_ai`, `_ad`, `_au` on insert/delete/update.
`src/main/db/migrations.ts` remains the source of truth and has grown since;
migration 18 (#515) adds a `boards` table — album-class moodboard organizational
metadata (board fields in columns; the ordered placement list as canonical JSON
in a `placements` column). Placements are references, so `boards` has **no
foreign key to `photos`**: deleting a photo leaves an "unavailable" placement
rather than cascading the layout away. Migration 19 (#741) adds
`backup_manifest_debt` — a single-row flag recording that the remote is owed a
manifest generation, durable across restart so an interrupted or fail-closed
backup run never forgets the stale remote manifest. Migration 20 (#729) adds
`custody_authorities` and the nullable `sync_ledger.custody_authority_id`
foreign key. The binding records a sole-remote original's non-secret provider,
account subject, and namespace; existing offloaded rows remain `NULL`
(legacy-unbound) until a later verified reconciliation proves their home.

**10 migrations**, forward-only with no down path, each applied in its own
transaction and tracked in `schema_migrations(version, applied_at)` — _not_
`PRAGMA user_version`, which is the detail most reimplementations assume.

**FTS5 must be compiled in.** It is present in SQLCipher's amalgamation but
**not** in Apple's system SQLite, so a client linking the system library will
open the database and then fail on first search.

## 10. Protected albums (extension)

An additional layer over §6 for albums that stay sealed while the rest of the
library is open. Per-album key **A**, 32 random bytes, sealed into slots by both
a password and the master key (so recovery works without the album password).

### 10.1 Protected blobs

Path:

```
protected-blobs/<albumRef[0:2]>/<albumRef>/<blobRef>.<kind>
      albumRef = hex SHA-256(utf8(albumId))
      kind ∈ { original, thumb, mid }
```

`blobRef` **opaques** the ordinary content hash so equal bytes are only
recognizable within one album:

```
blobRef = hex HMAC-SHA256(key = A, message = "overlook-protected-blob-v1\0" ‖ ascii(contentHash))
```

The trailing `\0` is part of the message. `contentHash` is fed as ASCII, i.e.
the 64 hex characters, not the 32 raw bytes.

The blob body reuses the §6 envelope **unchanged**, with two substitutions:

- key id is the literal **1**, and the key is **A** — not a `keys.json` entry.
  Do not resolve key id 1 against §5 for these files.
- the envelope's `photoId` AAD field is the synthetic string
  `protected:<albumId>:<blobRef>:<kind>`.

### 10.2 Protected photo metadata (`OVPP`)

```
"OVPP" ‖ UTF-8 JSON { "version": 1, "nonce": "<base64>", "ciphertextAndTag": "<base64>" }
```

Encrypted under **A**. Ciphertext ‖ tag, tag last. AAD is the UTF-8 bytes of the
**JSON array**:

```
["OVPP",1,"<libraryId>","<albumId>","<photoId>","AES-256-GCM"]
```

serialized compactly (no spaces), binding library, album, and photo identity.

## 11. Magic byte registry

| Magic     | Where                           | Meaning                  |
| --------- | ------------------------------- | ------------------------ |
| `OVLK`    | blob/thumb/protected-blob files | envelope header (§6)     |
| `OVLK`    | `master.key` first 4 bytes      | app-lock record (§4.2)   |
| `OVLK1\n` | `app-lock.configured`           | 6-byte configured marker |
| `OVRK`    | `overlook-recovery.key`         | recovery file (§8)       |
| `OVPP`    | protected photo metadata        | sealed metadata (§10.2)  |

`OVLK` is overloaded across two unrelated formats, disambiguated only by
filename. Do not sniff for it generically.

## 12. Traps

Every one of these is a real inconsistency in the current format that a second
implementation will get wrong at least once.

1. **Tag ordering is not consistent.** `keys.json` wrapped keys are
   `nonce ‖ tag ‖ ciphertext`. App-lock slots (§4.2), recovery files (§8), and
   protected metadata (§10.2) are `ciphertext ‖ tag`. There is no rule; check
   each site.
2. **The app-lock record is canonical-JSON-sensitive.** It is validated by
   re-serializing the parsed object and comparing to the original string, so
   **field order and exact formatting are load-bearing**. Emit keys in the order
   shown in §4.2, compact (no added whitespace). The same applies to the sealed
   record in §10.2. The freshness anchor hashes the raw bytes, so any
   reformatting also invalidates the anchor.
3. **Fan-out depth differs** — two levels for originals, one for thumbnails.
4. **The content hash is of plaintext**, never of the envelope.
5. **`safeStorage` holds base64**, not raw key bytes.
6. **`totalChunks` is 0 on non-final chunks** and is covered by the AAD, so
   writing the real total early breaks every tag.
7. **Protected blobs hardcode key id 1** and must not be resolved against
   `keys.json`.
8. **`ephemeral/` is wiped on every init** and must never be treated as durable.
9. **Envelope AAD has no length prefix** on `photoId`, so a photo id containing
   bytes that collide with the fixed suffix would be ambiguous in principle.
   Photo ids are ULIDs today, so this is currently safe — but do not relax that
   without revisiting the AAD.

## 13. Known gaps

Named rather than papered over:

- **No test vectors.** This spec has no golden fixtures, so a second
  implementation cannot self-check. The single highest-value follow-up is a
  committed fixture set — a sealed envelope, a wrapped key, a recovery file, an
  app-lock record, and a small SQLCipher database with known keys — following the
  pattern already proven in `design/handoff/contracts/v1/` (published schemas,
  golden fixtures, `SHA256SUMS`, CI-enforced acceptance). That work needs a PR
  and gates; this page deliberately does not.
- **SQLCipher interoperability is unverified.** Parameters match SQLCipher 4
  defaults and SQLite3 Multiple Ciphers documents its `sqlcipher` scheme as
  compatible with SQLCipher 1–4, but **no upstream SQLCipher build has been used
  to open a real `library.db`**. Until someone does, §9 is inference.
- **`plaintext_header_size = 0`** means the SQLite magic is encrypted. SQLCipher
  documents a non-zero plaintext header specifically so iOS can recognize the
  file as a database. If iOS requires it, changing it is a **format change to
  every existing library**.
- **The credential anchor has no portable design** (§4.2). This spec describes
  what exists; it does not solve custody.
- **The backup/offload remote format is out of scope here** — see
  [ADR-0007](./adr/ADR-0007-Backup-Format-And-Offload.md),
  [ADR-0009](./adr/ADR-0009-Cloud-Recovery-Bootstrap-And-Manifest-V2.md), and
  [ADR-0012](./adr/ADR-0012-Continuous-Backup-Integrity-And-Recovery-Repair.md). Blobs
  are uploaded as-is (encrypt-once), so §6 covers their bodies.
- **The full SQL schema is not reproduced.** `src/main/db/migrations.ts` is the
  source of truth; a second implementation reads the same forward-only
  migrations.

## 14. Implementation order

For anyone building a reader, cheapest proof first:

1. Parse an envelope header and recover the key id (§6) — no crypto needed.
2. Open a recovery file with a known password (§8) — self-contained, 77 bytes,
   exercises scrypt and GCM-with-AAD in one step.
3. Unwrap `keys.json` with the recovered master (§5) — catches the tag-order trap.
4. Decrypt a single-chunk thumbnail (§6, §7) — catches the AAD layout.
5. Decrypt a multi-chunk original and verify the plaintext SHA-256 matches its
   path (§6, §7) — catches nonce derivation and chunk sequencing.
6. Open `library.db` (§9).
7. Only then attempt the app-lock record (§4.2) and the anchor question.
