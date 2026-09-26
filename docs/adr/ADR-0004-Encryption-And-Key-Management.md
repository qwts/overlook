# ADR-0004: Encryption & Key Management

## Status

Accepted (proposed 2026-07-12 on issue [#65](https://github.com/qwts/photos/issues/65); accepted under the owner's standing work-through-M11 authorization after an open review window — any section may still be amended by owner veto before its implementing code lands)

**Extended 2026-09-26 by [ADR-0035](./ADR-0035-Same-Mac-Master-Key-Backup.md) ([#1312](https://github.com/qwts/overlook/issues/1312)):** a same-Mac macOS login-keychain copy of the master key.

## Context

Overlook stores originals "encrypted with your key" and the design surfaces
`AES-256 · GCM · KEY #2` in the Inspector — encryption at rest is a product
invariant that "cannot be disabled", not a feature flag. Every M03 crypto
sub-issue needs a recorded scheme to cite instead of re-deciding: cipher and
envelope, key hierarchy, custody, recovery, and whether the database itself is
encrypted. The design handoff's sibling product (Image Trail) uses
password-wrapped PBKDF2 → AES-GCM envelopes; Overlook is a desktop app with an
OS keychain available, so its custody model can be stronger than a password.

## Decision

**Blob encryption — AES-256-GCM streaming envelopes.** Originals and derived
images are encrypted in 4 MiB chunks. Each chunk is sealed with AES-256-GCM;
the nonce is a random 64-bit per-blob prefix + 32-bit chunk counter (nonce
reuse impossible within a key's lifetime at our volumes). AAD binds each chunk
to `photo id + key id + chunk index`, and the final chunk carries a
total-chunk-count marker so truncation is detectable. Integrity: the GCM tag
per chunk, plus the SHA-256 content hash of the plaintext original stored in
the database (also the blob-store address, ADR-0005).

ADR-0013 protected domains use the same authenticated streaming envelope but
replace the ordinary photo context with `protected album id + opaque blob ref +
derivative kind`. Their address is HMAC-SHA-256 under the album key over the
plaintext hash, so equality is visible only inside one authorized album. The
ordinary plaintext hash remains sealed protected metadata and never becomes a
protected filesystem or provider address.

**Key hierarchy — master key → versioned library keys.**

- A random 256-bit **master key** exists once per library. It never touches
  the database; it only wraps other keys.
- Versioned 256-bit **library keys** (`KEY #1`, `KEY #2`, … — the ids the
  Inspector shows) are stored in the `keys` table wrapped by the master key.
  Blobs record the key id that sealed them.
- **Rotation (v1):** creating a new library key makes it the write key — new
  imports and re-encrypts use it. Existing blobs stay on their original key
  and are **not** lazily re-encrypted in v1; rotation limits future exposure,
  it does not retroactively re-seal history. Recorded plainly so the Inspector
  copy stays honest.

**Master-key custody — OS keychain via Electron `safeStorage`, with a
required recovery phrase.**

- The master key is wrapped by `safeStorage` (Keychain on macOS, DPAPI on
  Windows, secret service on Linux) and stored in the library directory.
- **Linux caveat:** when no secret service is available `safeStorage` falls
  back to weak obfuscation. Overlook detects this
  (`safeStorage.isEncryptionAvailable()`), warns explicitly, and refuses to
  describe the library as keychain-protected — factual security copy, never
  marketing.
- **Recovery (v1): a recovery phrase is generated at library creation** —
  BIP39-style words encoding the master key — shown once with instructions to
  store it offline. This is not optional polish: restoring a pCloud backup on
  a new machine has no OS keychain to read, so a portable key path must exist
  for backup to mean anything. Stated plainly in-product: _"Lose the keychain
  and the phrase, and the library cannot be decrypted. There is no other
  recovery."_

**Database at rest — whole-DB encryption (SQLCipher family).** Filenames,
EXIF, GPS coordinates, and places are exactly as sensitive as pixels; a
plaintext catalog next to encrypted blobs leaks most of what matters.
Field-level encryption would destroy indexing and querying (no index over an
encrypted `place`). The database is SQLCipher-encrypted
(`better-sqlite3-multiple-ciphers` or equivalent — final module choice rides
ADR-0006's native-module policy), keyed by a DB key wrapped by the master key.

**Threat model (v1), stated per the security-copy voice:**

- **Protects against:** device theft / disk imaging (everything at rest is
  ciphertext); the backup provider (pCloud holds only client-side-encrypted
  bytes); other OS users without the keychain session.
- **Does not protect against:** a compromised OS or session (keys are in
  process memory while the app runs); an attacker with the recovery phrase;
  traffic/size analysis by the backup provider (blob count and sizes are
  visible).

## Consequences

- M03 sub-issues implement against named sections here (envelope, `keys`
  table, custody, recovery) instead of debating scheme choices in PRs.
- The recovery-phrase flow becomes a hard requirement of library creation
  (M03) and of backup restore (M08) — UI copy for it must follow the design
  system's factual security voice.
- SQLCipher pulls the database driver into ADR-0006's native-module policy
  (prebuilds, Electron ABI, exact pins); if that policy rules the SQLCipher
  variant out, this ADR must be revisited **before** M03 starts, not worked
  around silently.
- Chunked GCM means streaming import/export without whole-file buffering, at
  the cost of a small per-chunk overhead (16-byte tag per 4 MiB).
- Lazy re-encryption after rotation is explicitly deferred; if it becomes a
  requirement, it arrives as a new ADR amending the rotation section.

## Accepted deviations & review notes

Appended after the M11 security review ([#129](https://github.com/qwts/photos/issues/129);
full write-up: [Security Review M11](../Security-Review-M11.md)). The review found the
crypto, IPC, and plaintext-at-rest seams **sound and well-tested** against this
ADR's threat model; the notes below record where the implementation's guarantee
is weaker than the prose above, with the accepted position.

- **Nonce uniqueness is probabilistic, not enforced (accepted for v0.x).** The
  "nonce reuse impossible within a key's lifetime at our volumes" claim in the
  _Blob encryption_ section rests on a **64-bit random per-blob prefix**
  (`envelope.ts` `nonceFor`), so uniqueness is a birthday bound (N²/2⁶⁵ under
  one key), not an invariant: negligible (~2⁻²²) at a few million blobs/key,
  ~1/130k by ~16M, 50% at 2³². Rotation resets the per-key population, which is
  the practical mitigation. **Accepted** for single-user libraries at realistic
  photo volumes; **not release-blocking**. Hardening (a persisted per-key blob
  budget that forces rotation, or a monotonic counter as the nonce fixed field
  for a deterministic-unique construction) is tracked in
  [#229](https://github.com/qwts/photos/issues/229) and must land before
  libraries can approach ~2³⁰ blobs/key. The prose above is left intact per the
  append-only convention; this note is the correction of record.
- **Counter overflow is loud, not silent.** `nonceFor` writes the 32-bit
  counter with `writeUInt32BE`; a chunk index ≥ 2³² throws rather than wrapping
  into a reused nonce. Unreachable per blob (2³² × 4 MiB ≈ 16 EB) but confirmed
  fail-loud.
- **No unverified-plaintext release.** Each whole chunk is buffered before
  decrypt and pushed only after `decipher.final()` authenticates — the classic
  streaming-GCM release-before-verify pitfall is avoided. Truncation, chunk
  reorder/drop, cross-photo/cross-key substitution, and post-final extension all
  fail closed (AAD binds photoId + keyId + chunkIndex + flags + totalChunks on
  every chunk).
- **Dev seams fail closed in packaged builds.** `OVERLOOK_INSECURE_KEYSTORE`
  was already gated on `!app.isPackaged`. The M11 review (F1) extended the same
  gate to the remaining harness env hooks (seed / synthetic-seed / fixture
  import & export dirs / injected backup faults / profile override) via a single
  `harnessEnv()` accessor, so a **packaged app is not steerable via env**. The
  master key is persisted only through `safeStorage`; there is no plaintext key
  fallback (custody refuses to run without an OS keychain).
- **DB key is pinned to KEY #1** (`index.ts`) independent of blob-write-key
  rotation — matches the "rotation only moves the blob write key" decision
  above; noted so the rotation story stays honest. Not a finding.

## Nonce hardening implementation note

Appended when [#229](https://github.com/qwts/photos/issues/229) implemented the
hardening required by the accepted-deviation note above.

- **Versioned library keys now use deterministic-unique prefixes.** `KeyStore`
  owns a 64-bit monotonic prefix counter for each key and supplies the reserved
  value to the unchanged envelope header. `createEncryptStream` still uses the
  32-bit chunk index as the suffix, so every `(key, nonce)` pair is unique until
  the 64-bit prefix space is exhausted. Existing random-prefix envelopes remain
  readable without migration.
- **Reservations are crash-safe ranges.** `keys.json` stores an exclusive
  `nonceHighWater` decimal string. A process reserves 1,024 values and persists
  the new bound before returning the first prefix. Restart begins at the bound,
  intentionally skipping an unused tail rather than risking reuse. Exhaustion
  fails closed and requires rotation.
- **Recovery preserves the bound.** Backup manifest sealing consumes its prefix
  before the recovery bootstrap snapshots the wrapped-key records. A restored
  library therefore resumes strictly beyond every ordinary blob and manifest
  nonce represented by that generation.
- **Legacy keys cross a one-time boundary.** A record without nonce state is
  assigned and persisted a random starting point in the upper half of the
  64-bit space before its first new envelope. This preserves the negligible
  one-time collision risk against its historical random prefixes, then removes
  birthday growth for every subsequent write. Fresh keys begin at zero.
