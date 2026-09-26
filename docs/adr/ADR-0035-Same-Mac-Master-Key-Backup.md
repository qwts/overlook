# ADR-0035: Same-Mac Master-Key Backup

## Status

Proposed on [#1312](https://github.com/qwts/overlook/issues/1312) (2026-09-26). Implementation of the item waits until this status is Accepted.

This ADR extends [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md) and [ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md). It rewrites neither decision body. [ADR-0008](./ADR-0008-Recovery-Key-Format.md) remains the portable recovery artifact. [ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md) remains the app-lock ceremony.

## Context

[#1282](https://github.com/qwts/overlook/issues/1282) failed when this Mac could not unwrap `master.key`. Library IPC rejected, and the grid reserved a single loading tile. [#1283](https://github.com/qwts/overlook/pull/1283) surfaces that failure and accepts the exported recovery key. The owner used that screen and the library opened. The same report asks for a keychain copy of the master, and for Safe Storage names that do not collide across libraries or instances.

The custody facts that force a new record:

- [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md) wraps the 32-byte master with Electron `safeStorage` and stores that ciphertext in the library directory. Electron keeps one Safe Storage password per app.
- [ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md) §3 isolates libraries by open and close. `safeStorage` grants are per app. UI copy must not claim a per-library OS ACL. The only per-library OS item today is the app-lock anchor, whose account is the library ULID and whose value is `{libraryId, generation, SHA-256(record)}` (`src/main/crypto/credential-anchor.ts`).
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
- **Writer:** the platform helper the app-lock anchor already uses (`src/main/crypto/credential-anchor.ts`): macOS `/usr/bin/security` generic password, Linux `secret-tool`, Windows Credential Manager. Same helper, this service and account.
- **Local only.** The macOS item is a login-keychain generic password and is not synchronizable. It does not travel to a new Mac.
- **ACL.** The item trusts the signed Overlook application. An unsigned dev binary may be denied. Denial uses the recovery screen from #1282. The ACL stays limited to the signed application, and Electron's Safe Storage service name stays the name Electron defines.

### 2. Write

After a successful create, or after a successful `safeStorage` unwrap of `master.key`, write or replace the item for that library. The write covers the library being created or opened. Other libraries are left for their own open.

A recovery-key import that installs a master rewrites `master.key` through `installRecoveredMaster` (`src/main/crypto/recovery.ts`). The next successful unwrap writes the item.

While `master.key` is an `OVLK` record, do not write the item.

### 3. Read

Read the item only after `safeStorage` decrypt of an existing non-`OVLK` `master.key` fails, and only when the OS secret store is available.

The decoded value must be 32 bytes and must unwrap every `keys.json` row, the same voucher `installRecoveredMaster` already requires. On success, replace `master.key` atomically with a `safeStorage` wrap under the current password, then open.

An absent item, a value that is not 32 bytes, or a master that does not unwrap `keys.json` leaves `master.key` untouched. The #1282 recovery screen stands (`unwrap-failed` or `malformed`).

An unavailable secret store keeps the `keychain-unavailable` screen and does not consult the item.

An `OVLK` file does not read the item. The lock screen owns that library, including when Safe Storage is down.

A successful read adds no IPC reason. `library:custody` stays on `ok`, `unwrap-failed`, `malformed`, and `keychain-unavailable`. Raw key bytes and OS error text stay in the main process.

### 4. Deletion

`removeEntry` does not delete the item. The directory remains, and adding that directory back finds the same backup.

The action that deletes a library directory deletes the item in that same action. This ADR does not create that action. The implementation that adds directory destruction deletes the item.

Configuring app lock deletes the item before the `OVLK` record is committed. A failed delete aborts the transition. Removing app lock returns `master.key` to the `safeStorage` form; the next successful unwrap writes the item again.

A copied library that mints a fresh ULID ([ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md) §2) has no item under the new id. A moved library keeps its ULID and its item.

### 5. Boundaries

Electron keeps one Safe Storage password for the app. This item is a separate service, so libraries and instances do not share a name inside that password.

The exported recovery-key file ([ADR-0008](./ADR-0008-Recovery-Key-Format.md)) remains the copy that moves to another machine. In-product copy for this backup states that without the keychain backup and the recovery key, the library cannot be decrypted. [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md)'s recovery-phrase sentence stays in that record.

`OVLK` recovery is unchanged. There is no startup pass that rewraps every library.

## Consequences

- The signed app can open a library after the Safe Storage password is replaced, when this item was written by a build the item trusts.
- App-lock configuration gains a delete-before-commit step. A dev build outside the ACL still depends on the exported recovery key.
- Directory destruction, when it is specified, owns deletion of this item.
- Keychain code lands in a later change, after this status is Accepted. Until then the #1282 recovery screen is the only path for an unwrap failure.
