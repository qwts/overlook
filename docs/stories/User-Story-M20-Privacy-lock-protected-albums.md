# M20: Privacy Lock, Touch ID, and Protected Albums

**Epic:** [#305](https://github.com/qwts/photos/issues/305) · **Lane:** Lane B — Core with Lane A/C UI

M20 adds a cryptographic whole-app lock, opt-in native Touch ID release on supported signed macOS builds, and independently authorized protected albums. [ADR-0013](../adr/ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md) is the prerequisite contract: locked means the main process has no decryption authority, recovery remains rooted in the ADR-0008 file, and protected content occupies a separate key/query domain.

## Delivery order

| #                                                 | Title                                           | Dependency                     |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| [#308](https://github.com/qwts/photos/issues/308) | ADR: credential, recovery, and key release      | First                          |
| [#311](https://github.com/qwts/photos/issues/311) | App-lock lifecycle, settings, and unlock screen | #308                           |
| [#310](https://github.com/qwts/photos/issues/310) | Native Touch ID with password fallback          | #308 and #311 key-release seam |
| [#309](https://github.com/qwts/photos/issues/309) | Protected albums and leakage isolation          | #308                           |

#309 is delivered in order through [#325](https://github.com/qwts/photos/issues/325) key custody and sealed metadata, [#326](https://github.com/qwts/photos/issues/326) crash-safe photo migration, [#327](https://github.com/qwts/photos/issues/327) leakage enforcement, [#328](https://github.com/qwts/photos/issues/328) backup/restore/sync/offload, and [#329](https://github.com/qwts/photos/issues/329) user workflows.

## Implementation status

- #308 contract: complete; ADR-0013 accepted.
- #311 app-lock lifecycle: implemented by [PR #323](https://github.com/qwts/photos/pull/323). Configured launch withholds the master key until password release; main-process IPC/protocol admission, crash-resumable OVLK/anchor transitions, persistent throttling, recovery-file re-establishment, lifecycle locking, work drain, cache zeroization, Privacy controls, and the dedicated lock surface are covered.
- #310 Touch ID is implemented by [PR #324](https://github.com/qwts/photos/pull/324), pending the owner-run signed/notarized hardware checklist below. It uses a signed Node-API bridge, the macOS Data Protection Keychain, current-enrollment Touch ID access control, Settings opt-in/out, and an always-visible password fallback.
- #309 protected albums are split into #325–#329. [PR #330](https://github.com/qwts/photos/pull/330) implements #325's non-user-visible key, credential, sealed-metadata, persistence, and main-process session-authority foundation. [PR #342](https://github.com/qwts/photos/pull/342) implements #326's opaque protected blob store, sealed photo metadata, crash-safe protect/unprotect/move journal, startup rollback/resume, and last-copy verification. [PR #353](https://github.com/qwts/photos/pull/353) implements #327's ordinary-query exclusion, authorized protected route, domain-scoped media protocols, cache/in-flight revocation, opaque failure behavior, and relock-safe export boundary. [PR #354](https://github.com/qwts/photos/pull/354) implements #328's schema-3 sealed recovery catalog, ciphertext-only provider namespace, verify/repair, authorized offload/rehydrate, and closed fresh-machine restore. [PR #356](https://github.com/qwts/photos/pull/356) implements #329's Privacy ceremonies, generic locked rows, session route, accessibility states, ordinary-grid invalidation, and Electron leakage/lifecycle journey. The complete #309 chain is implemented pending #356 merge.

## Product and privacy rules

- Configured launch starts locked before database, key store, thumbnails, or library UI opens.
- Locking revokes main-process authority, cancels sensitive work, clears caches, closes the database, and zeroizes keys.
- Password, derived key, biometric, decrypted metadata, and protected route state never enter renderer persistence, logs, telemetry, provider plaintext, or ordinary temp files.
- App-password recovery requires the separately saved recovery file; without it, reset is destructive erase.
- Touch ID is opt-in, current-enrollment/device-only, signed-build-only, revocable, and always offers password fallback.
- Protected photos, metadata, names, counts, thumbnails, exports, sync state, routes, and diagnostics remain outside every ordinary library surface.
- A photo belongs to at most one protected key domain; conflicts require an explicit authorized move.

## Locked boundary

The only locked-state actions are status, password unlock, supported biometric request, recovery-file selection/import, safe window controls, and quit. Library/album/settings mutations, protocols, import/export, backup/restore, provider operations, menus, shortcuts, deep links, caches, recents, and diagnostics fail closed in the main process.

## Recovery summary

The app password releases a random unlock key that wraps the existing master. The ADR-0008 recovery file continues to carry the master itself, so a fresh machine can restore the library and set a new local app password without knowing the forgotten one. Touch ID is disabled after recovery or password changes until the user opts in again. Protected-album password recovery requires that same recovery-file ceremony.

### Anchor loss and migration

Existing and newly configured libraries use the usability anchor policy by default. If migration, restore, or OS credential-store loss removes or changes only the local anchor while the credential record remains intact, a correct app password or matching device-bound Touch ID enrollment repairs the anchor before the library opens. Malformed credential records still require recovery, and a credential-store write failure stays locked without consuming an authentication attempt.

Privacy settings can enable hardened anchor protection. Enabling it requires a recovery-key export completed in that settings ceremony, explicit acknowledgement that migration or credential-store loss will require that file, and the current app password. Hardened libraries never repair a missing or changed anchor from the password slot; they open the existing recovery-key picker and establish new local custody only after the exported key is authenticated. A fresh machine therefore needs the exported recovery key, then a new app password and optional Touch ID enrollment.

## Acceptance coverage

The complete testable matrix is in ADR-0013. The repo ledger tracks:

- `m20-app-lock-lifecycle` → `tests/e2e/app-lock.spec.ts`, lock-screen Storybook interactions, custody/state-machine tests, and packaged manual evidence
- `m20-touch-id-unlock` → native adapter/custody tests, `tests/e2e/app-lock.spec.ts`, lock-screen Storybook interactions, and the signed checklist below
- `m20-protected-albums` → [Protected Albums acceptance](../acceptance/Acceptance-Test-Protected-Albums.md), `tests/e2e/protected-albums.spec.ts`, protected ceremony/view Storybook interactions, and the custody/migration/leakage/cloud suites from PRs #330, #342, #353, #354, and #356. The deferred ledger entry is replaced by executable evidence.

Each child must supply unit, Storybook, Electron E2E, security-review, and required signed-build/manual evidence. The epic closes only after the bypass, crash/restart, accessibility, recovery, and leakage matrices all pass.

### #311 packaged acceptance checklist

1. Configure an app password, quit, and confirm the next launch shows no library frame before the lock surface.
2. Exercise Lock now, native screen lock, suspend/resume, user switch, idle choices, and optional minimize/hide on macOS and Windows.
3. Confirm password-manager behavior, keyboard-only focus order, screen-reader announcements, reduced motion, and minimum-window layout.
4. Run backup/import/export before locking and confirm lock cancels or drains it without corrupting the library; a hung operation must relaunch locked.
5. Change and remove the password with correct and incorrect current credentials; recover with the matching exported key and reject another library's key.

### #310 Touch ID custody and packaging

Touch ID releases `U`; it never stores or releases `M` directly. Explicit opt-in re-authenticates the current app password, copies `U` into a generic-password item with service `com.zts1.overlook.touch-id-unlock`, then zeroizes the temporary copy. The item uses the Data Protection Keychain with `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, `kSecAccessControlBiometryCurrentSet`, and synchronization disabled. The repo stores only a non-secret marker bound to the current library id, credential generation, and record hash.

The native bridge loads only in packaged macOS processes and verifies the running main executable on every operation: bundle id `com.zts1.overlook`, strict non-ad-hoc signature, Team ID `Z5DM34QS5U`, and application identifier `Z5DM34QS5U.com.zts1.overlook`. Those restricted values live only in `build/entitlements.mac.provisioned.plist`; the application identifier supplies the app's private Data Protection Keychain group. No Keychain sharing group is requested because Overlook never sets `kSecAttrAccessGroup`. `build/entitlements.mac.inherit.plist` deliberately omits Keychain identity from renderer/helper executables. The `.node` bridge is unpacked from ASAR and signed as nested code. The packaged Info.plist carries `NSFaceIDUsageDescription` as Apple's biometric-project usage declaration even though this macOS flow permits only Touch ID.

Password change, removal, and recovery rotate or remove `U`, clear the native item, remove the marker, and require explicit opt-in again. `biometryCurrentSet` invalidates the item when enrolled fingers change. A biometric nonmatch counts against the shared three-attempt recovery budget; native cancellation, unavailability, lockout, and storage failures do not mutate that budget. Unsupported platforms, unpackaged processes, malformed/missing native modules, unsigned/ad-hoc builds, mismatched entitlements, missing enrollment, lockout, and secure-storage failures remain locked and return only stable reason codes.

### #310 signed/notarized owner checklist

Use a notarized release candidate on a Touch ID Mac. CI's memory-only adapter is packaged-build-gated and is not evidence for these steps.

1. Verify `codesign --verify --deep --strict --verbose=2 /Applications/Overlook.app` succeeds and `spctl --assess --type execute --verbose=2 /Applications/Overlook.app` accepts the app.
2. Run `codesign -d --entitlements - /Applications/Overlook.app` and confirm the main executable contains `com.apple.application-identifier` = `Z5DM34QS5U.com.zts1.overlook` and `com.apple.developer.team-identifier` = `Z5DM34QS5U`. Inspect `/Applications/Overlook.app/Contents/Frameworks/Overlook Helper (Renderer).app` the same way and confirm those two keys are absent. Confirm `Contents/embedded.provisionprofile` exists and `plutil -extract NSFaceIDUsageDescription raw -o - /Applications/Overlook.app/Contents/Info.plist` returns `Unlock Overlook with Touch ID.`; the Package workflow's `verify-macos-provisioned-app.mjs` gate automates this step.
3. Set an app password, enable Touch ID in Privacy with the correct current password, quit, relaunch, and unlock with an enrolled finger. Confirm the gallery appears only after the native prompt succeeds.
4. Lock again. Cancel the native prompt and confirm the shared attempt count is unchanged. Then present an unrecognized finger and confirm the app stays locked, distinct failure copy appears, the shared attempt count decreases, and password fallback observes the same retry delay and remaining-attempt budget. After the delay, unlock with the app password and confirm the budget resets.
5. Trigger macOS biometric lockout and confirm Touch ID is disabled for that attempt while password unlock still works. Do not claim this step from an ordinary failed-scan result.
6. Add or remove an enrolled finger, relaunch, and confirm the old item is rejected, the Touch ID action disappears after reconciliation, and password unlock plus a fresh opt-in restores it.
7. Change the app password, remove/reconfigure app lock, and recover with the exported key in separate passes. After each credential transition, confirm the previous Touch ID item cannot unlock and Privacy reports Touch ID off.
8. Opt out in Privacy, restart, and confirm no Touch ID action appears. Re-enable, then disable the Mac login password/passcode only if this can be done safely on the test machine; confirm the item is deleted/unavailable and password fallback remains.
9. Search application logs, crash reports, renderer storage, diagnostics, and provider objects for the test password and known `U`/`M` sentinel values. None may appear; only opaque Touch ID reason codes are permitted.
