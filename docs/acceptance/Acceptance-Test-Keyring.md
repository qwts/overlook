# Acceptance test — Library keyring (#517)

**Encryption keys** (Settings ▸ Privacy) lists the library keyring: every key
the library has sealed photos or sidecars under, with its `KEY #N`, the
`(key_ref, version)` identity's fingerprint, an optional label, what it still
seals, and whether this device holds the material. The rules are
[ADR-0032 §2](../adr/ADR-0032-Sharing-And-End-To-End-Encrypted-Collaboration.md): a key is
identified by an opaque 128-bit reference and a version, never by its
material; the registry rides the backup manifest (schema 15) so a restored
library keeps every identity; and removing a key is a custody decision that
leaves its objects **locked** — present in the library, unopenable — rather
than deleting them. KEY #1 also keys the database and can never be removed;
the write key (the one new imports seal under) cannot be removed either.
Removing a key that still seals anything is Tier D and requires the
`keyring.remove-key.v1` authorization; a key that seals nothing is Tier M.

A key file (`overlook-key-<ref>-v<N>.key`, 100 bytes) is sealed with a
password (scrypt + AES-256-GCM, the registry facts authenticated with the
key). Import names the registry row from the file's reference before any
password work, refuses a reference this library never sealed anything under,
and — after the password opens the file — refuses material that does not
open at least one object sealed under that row. Identical material already
held is idempotent; different material under a held reference is refused.

Automated coverage: `tests/e2e/keyring.spec.ts`,
`tests/crypto/keyring-service.test.ts` (reconcile, refusals, the Tier D
ceremony over the real KeyStore/DB/BlobStore, export → import round trip),
`tests/crypto/key-file.test.ts` (the sealed file), `tests/db/keyring.test.ts`
(migration 36, the registry, the locked projection),
`tests/backup/keyring-manifest.test.ts` (schema 15, link checks, restore with
an absent key), `KeyringSection.stories.tsx › Registry / RemoveCeremony /
ImportCeremony`.

## Steps

1. Launch with `OVERLOOK_SEED=4 OVERLOOK_SEED_RETIRED_KEY_FROM=2` (or import
   two photos, rotate the key from a dev build, import two more, rotate
   again). Open Settings ▸ Privacy. **Expected:** an **Encryption keys**
   section with three rows: KEY #1 (**Database**), KEY #2 (**Retired**,
   "2 photos"), KEY #3 (**Write key**). **Remove…** is disabled on KEY #1
   and KEY #3.
2. KEY #2 → **Export…**. Enter a strong password twice, tick the
   cannot-be-reset acknowledgment, press **Export key file**, choose a
   destination. **Expected:** "Key file saved to …"; the file is exactly
   100 bytes and contains neither the password nor the key.
3. KEY #2 → **Remove…**. **Expected:** a dialog titled **Remove this key?**
   naming the side effects, a counts block (Photos 2 · Sidecars 0 · Sealed
   bytes), and a disabled **Remove key permanently** button until the
   acknowledgment is ticked.
4. Confirm. **Expected:** "KEY #2 removed · 2 photos locked"; the row now
   reads **Not on this device** with Export and Remove disabled; the two
   photos show a lock placeholder in the grid, list and feed views; the
   Inspector shows a **Custody** row "LOCKED — KEY #2 IS NOT ON THIS
   DEVICE"; the lightbox shows the lock panel instead of the image.
5. Relaunch. **Expected:** the two tiles are still locked (the registry
   persisted the absence); nothing was deleted.
6. **Import key…** → choose the exported file → wrong password →
   **Verify & import**. **Expected:** "Wrong password (or a corrupted
   file)…"; nothing installed.
7. Correct password. **Expected:** "KEY #2 imported · 2 photos unlocked";
   the row reads **Imported**; the two tiles show their thumbnails again;
   KEY #3 stays the write key (imported custody is never the write key).
8. Import the same file again. **Expected:** "KEY #2 is already on this
   device — nothing changed."
9. Seal a file with the same reference but different material (a dev
   build's `sealKeyFile`), remove KEY #2 again, and import that file.
   **Expected:** "…does not open any photo it claims to seal. Nothing was
   installed." A file whose reference the library never used reads "This
   library has never sealed anything under that key".
10. Back up, then restore from a recovery bootstrap that lacks KEY #2.
    **Expected:** the restore completes; KEY #2's row is **Not on this
    device**; its photos are locked and unlock after step 7.
11. Open a library created before this release. **Expected:** every existing
    key row gains a reference and fingerprint at first open; nothing reads
    as locked; the backup manifest publishes at schema 16.

## Locked backup work (#1134)

Remove a retired key while one of its photos has upload or manifest-only debt,
then run backup. Expect one `BACKUP-SKIP-LOCKED` summary with skip count and
key ids per run, no original
read or upload for that photo, and no upload failure attributed to the skip.
Pending counts exclude the photo immediately; its dirty flag and status survive.
Reimport the key: the count returns and the next backup resumes the work.

Current manifests continue carrying the photo and its keyring reference. Existing remote
blobs allow a manifest to publish while the key is absent. Skipped rows alone do
not trigger a new publication. If other work requires publication and a
never-uploaded locked photo has no remote blob, publication remains incomplete
with durable debt;
the completeness barrier must not publish a false remote-copy claim. Reimporting
the key allows the upload and publication to complete. Reconciliation must not
bypass the locked-row skip. Integrity sweeps also exclude locked rows and recheck
custody after asynchronous verification, so an absent key is never treated as
corrupt ciphertext or permission to repair a remote original.

Automated coverage: `tests/backup/backup-engine.test.ts`,
`tests/backup/integrity-scrubber.test.ts`, and the production keyring
factory notification test in `tests/crypto/keyring-service.test.ts`.

A companion can use a different key from its original. Removing either key locks
the owning photo's backup work and count. Remove a key while its original upload
or verification is in flight: the row must regain its previous status and remain
dirty, with no subsequent companion upload or ledger settlement. A request already
sent to the provider may finish; it does not count as completed backup while
custody is absent. Reimport resumes the whole photo/companion transaction.

Automated race and companion-key coverage: `tests/backup/sidecar-backup.test.ts`.
