# ADR-0035: Same-Mac Master-Key Backup

## Status

Accepted 2026-09-26 on [#1312](https://github.com/qwts/overlook/issues/1312). The owner approved the record the same day. Implementation of the macOS login-keychain item may proceed. Any section may still be amended by owner veto before that code lands.

This ADR extends [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md) and [ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md). It rewrites neither decision body. [ADR-0008](./ADR-0008-Recovery-Key-Format.md) remains the portable recovery artifact. [ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md) remains the app-lock ceremony.

## Context

[#1282](https://github.com/qwts/overlook/issues/1282) failed when this Mac could not unwrap `master.key`. Library IPC rejected, and the grid reserved a single loading tile. [#1283](https://github.com/qwts/overlook/pull/1283) surfaces that failure and accepts the exported recovery key. The owner used that screen and the library opened. The same report asks for a keychain copy of the master, and for Safe Storage names that do not collide across libraries or instances.

The custody facts that force a new record:

- [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md) wraps the 32-byte master with Electron `safeStorage` and stores that ciphertext in the library directory. Electron keeps one Safe Storage password per app.
- [ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md) §3 isolates libraries by open and close. `safeStorage` grants are per app. UI copy must not claim a per-library OS ACL. The app-lock anchor is the OS credential item the app writes today. `OsCredentialAnchorStore` accounts it by `sha256(dataDir)` (`src/main/crypto/credential-anchor.ts`). ADR-0017 §3 records a ULID re-key for that anchor; this code still hashes the directory. The anchor value is `{libraryId, generation, SHA-256(record)}`, not the master.
- A second packaged instance on one profile is refused (`src/main/app-bootstrap.ts`). The dev build and the packaged app share the default profile directory (`src/main/app-profile.ts`, `configureAppProfile`) and can still disagree on that one Safe Storage password. A sibling file sealed with the same password dies in the same rotation.
- Anchor service names already reserved in `src/shared/app-identity.ts` are `com.zts1.overlook.app-lock-anchor`, `com.zts1.overlook.app-lock-anchor-migration`, and `com.qwts.overlook.app-lock-anchor`.
- Registry removal forgets the row and leaves the directory (`removeEntry` in `src/main/library/library-registry-runtime.ts`). An action that deletes the library directory is named there and does not exist yet.
- An `OVLK` `master.key` is the app-lock record. A login-session copy of the raw master would release the library with no app-lock password.

## Decision

We will keep a second copy of the 32-byte master in the OS secret store. On macOS that store is the login keychain. The copy is read only after `safeStorage` fails to unwrap a non-`OVLK` `master.key`.

### 1. Item

- **Service:** `com.zts1.overlook.library-master`. The constant lives beside the anchor service names in `src/shared/app-identity.ts`.
- **Account:** the library ULID.
- **Value:** canonical base64 of the 32 master-key bytes. That is the plaintext encoding inside a `safeStorage` `master.key`, stored here as its own item. The value is neither the `safeStorage` ciphertext, nor JSON, nor an anchor payload.
- **Writer:** a new macOS writer that calls the Keychain from inside the Overlook process. It does not reuse `OsCredentialAnchorStore`. That class accounts by `sha256(dataDir)`, passes its value as the `-w` argument of `/usr/bin/security add-generic-password` (`src/main/crypto/credential-anchor.ts`), and the item that command creates trusts `/usr/bin/security`. Any same-user process can then read the value by invoking `security`. The master is a secret, so it is not a process argument, and the item does not trust `/usr/bin/security`.
- **Local only.** The item is a login-keychain generic password and is not synchronizable. It does not travel to a new Mac.
- **ACL.** The creating process is Overlook, so the item's trusted application is the signed Overlook binary. An unsigned dev binary may be denied. Denial uses the recovery screen from #1282. Electron's Safe Storage service name stays the name Electron defines.
- **Platform.** This record is macOS. Linux and Windows keep the #1282 recovery screen. A later amendment names their store, who can read the item, and that the item stays on that machine.

### 2. Write

After a successful create, or after a successful `safeStorage` unwrap of `master.key`, write or replace the item for that library. The write covers the library being created or opened. Other libraries are left for their own open.

A recovery-key import that installs a master rewrites `master.key` through `installRecoveredMaster` (`src/main/crypto/recovery.ts`). The next successful unwrap writes the item.

While `master.key` is an `OVLK` record, do not write the item.

### 3. Read

Read the item only after `safeStorage` decrypt of an existing non-`OVLK` `master.key` fails, and only when the OS secret store is available.

The decoded value must be 32 bytes and must unwrap every row of a `keys.json` that contains at least one row. `installRecoveredMaster` (`src/main/crypto/recovery.ts`) treats an empty or missing keys file as vouching for nothing and returns `mismatch` when `master.key` exists and there are no rows to check. This read refuses the same way and leaves `master.key` untouched. On success, replace `master.key` atomically with a `safeStorage` wrap under the current password, then open.

An absent item, a value that is not 32 bytes, or a master that does not unwrap `keys.json` leaves `master.key` untouched. The #1282 recovery screen stands (`unwrap-failed` or `malformed`).

An unavailable secret store keeps the `keychain-unavailable` screen and does not consult the item.

An `OVLK` file does not read the item. The lock screen owns that library, including when Safe Storage is down.

A successful read adds no IPC reason. `library:custody` stays on `ok`, `unwrap-failed`, `malformed`, and `keychain-unavailable`. Raw key bytes and OS error text stay in the main process.

### 4. Deletion

`removeEntry` does not delete the item. The directory remains, and adding that directory back finds the same backup.

The action that deletes a library directory deletes the item in that same action. This ADR does not create that action. The implementation that adds directory destruction deletes the item.

Configuring app lock deletes the item before the `OVLK` record is committed. A failed delete aborts the transition. Removing app lock (`AppLockCredentialStore.remove` in `src/main/crypto/app-lock-credentials.ts`) already holds the authorized master and writes the `safeStorage` form of `master.key` directly. That removal stores the item from the authorized master in the same transaction, before the buffer is cleared. The removal commits only when both that file and the item are stored. A failed item write leaves the `OVLK` record in place. Waiting for a later unwrap would leave the backup absent, which is the failure this record exists to cover.

A copied library that mints a fresh ULID ([ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md) §2) has no item under the new id. A moved library keeps its ULID and its item.

### 5. Boundaries

Electron keeps one Safe Storage password for the app. This item is a separate service, so libraries and instances do not share a name inside that password.

The exported recovery-key file ([ADR-0008](./ADR-0008-Recovery-Key-Format.md)) remains the copy that moves to another machine. In-product copy for this backup states that without the keychain backup and the recovery key, the library cannot be decrypted. [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md)'s recovery-phrase sentence stays in that record.

`OVLK` recovery is unchanged. There is no startup pass that rewraps every library.

## Consequences

- The signed app can open a library after the Safe Storage password is replaced, when this item was written by that signed app.
- App-lock configuration deletes the item before the `OVLK` record commits. App-lock removal writes the item again from the authorized master.
- An unsigned dev build that the Keychain ACL denies still depends on the exported recovery key. Linux and Windows stay on the #1282 recovery screen until a later amendment.
- Directory destruction, when it is specified, owns deletion of this item.
- Keychain code is a later change. Until it lands, the #1282 recovery screen is the only path for an unwrap failure.
