# Acceptance Test: Protected Albums

**Story:** [M20 Privacy Lock, Touch ID, and Protected Albums](../stories/User-Story-M20-Privacy-lock-protected-albums.md)  
**ADR:** [ADR-0013](../adr/ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md)  
**Epic:** [#309](https://github.com/qwts/photos/issues/309)  
**Workflow issue:** [#329](https://github.com/qwts/photos/issues/329)

## Contract

A locked protected album reveals only one stable opaque id and the generic
label `Protected album`. Its name, photo count, dates, sizes, metadata,
thumbnails, search membership, ordinary albums, global counts, notifications,
provider paths, and diagnostics stay outside ordinary surfaces. Album password
authority exists only for the current app-unlocked session and is revoked by
manual relock, ordinary navigation, credential change, app/session lifecycle,
shutdown, or restart.

Protect and remove are verified re-encryption migrations. Before commit,
cancellation rolls back to the verified source. After commit, startup retains
the last verified copy and resumes only after album authority is supplied.
Recovery requires the separately exported ADR-0008 key file and its password.

## Executable acceptance matrix

| Scenario                                                                                                             | Evidence                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Protect a populated ordinary album; remove its rows, memberships, photos, and counts from ordinary UI                | `tests/e2e/protected-albums.spec.ts`, `tests/library/protected-workflow-service.test.ts` |
| Restart with only a generic locked row and no file-name/image/summary bypass                                         | `tests/e2e/protected-albums.spec.ts`, `tests/library/protected-library-service.test.ts`  |
| Keyboard unlock, authorized real-photo route, focus-trapped lightbox, and focus restoration                          | Electron spec plus `ProtectedAlbumView.stories.tsx`                                      |
| Navigation and manual relock clear DOM state, reject late page responses, and revoke stale media URLs                | Electron spec plus protected library/protocol tests                                      |
| Password change, exported-key recovery, and verified removal/restoration                                             | Electron spec plus credential/workflow suites                                            |
| App lock, lock-screen, suspend, user resignation, shutdown, and restart revoke album authority                       | Electron spec, `app-lock.spec.ts`, authority/runtime tests                               |
| Progress, safe cancellation, conflict, failure, recovery mismatch, interruption, and completion copy                 | `ProtectedAlbumCeremony.stories.tsx`, workflow and migration suites                      |
| Corrupt source/destination and every crash boundary retain a verified copy                                           | `tests/crypto/protected-photo-migration-service.test.ts`                                 |
| Ordinary queries/counts/search/dedupe/status/diagnostics and cross-domain requests cannot discover protected records | protected repository/library/media/IPC suites from PR #353                               |
| Cloud namespace, backup, integrity repair, offload/rehydrate, and fresh restore remain ciphertext-only and closed    | protected backup/manifest/restore suites from PR #354                                    |
| Real photo fixtures, password-manager attributes, live regions, reduced motion, and 600px layout                     | Protected Storybook interactions and Electron spec                                       |

## Renderer leakage assertions

The Electron journey intentionally checks both main-process authorization and
the rendered document. Immediately after protection and after every relock it
requires:

- exact ordinary photo count and album removal;
- no protected album name or protected file name in visible text;
- no image with a protected file-name accessible label;
- protected summary IPC rejected while locked;
- protected media URL rejected after authority revocation;
- no horizontal overflow at the minimum 600px acceptance width.

The ordinary-grid invalidation is part of the security boundary: a committed
custody change broadcasts a library mutation so cached renderer photo records
are replaced, not merely hidden by CSS.

## Gate

Before merge, run:

```sh
npm run ci
npm run test:e2e
npm run test:stories:ci
```

The protected journey is included in the full Electron lane and the repo
acceptance ledger entry is `m20-protected-album-workflows`.

## Duplicate source custody (#1118)

Protecting a duplicate reads the shared original with its importing asset
owner's authentication identity, and reads the selected variant's own
thumbnail and mid preview. Both source identities are recorded in the durable
migration journal before the ordinary row is hidden. Version-2 sealed photo
metadata retains every edit revision and the head under album-key custody;
legacy version-1 records remain readable. Unprotect restores the retained
revision documents transactionally with the returned photo. New protected
copies become independent roots with album-keyed, photo-scoped blob references.
This spends an encrypted original copy per variant so their independent
presentations cannot alias; old references and payloads remain readable.
Recovery can therefore
finish cleanup even after commit removes that row.

1. Duplicate a photo, then protect the duplicate. Confirm its protected
   original and previews remain readable and the ordinary sibling still opens
   with its own previews.
2. In a separate fixture, remove the importing row while retaining its
   duplicate and original blob. Protect and then unprotect the duplicate.
   Use an edited duplicate and confirm its full history and head return
   unchanged. Confirm both domains can read the bytes and that the returned photo owns
   the newly encrypted ordinary envelope under its own ID.
3. Cancel before commit or interrupt after commit. Confirm rollback preserves
   the source, or authorized recovery verifies the protected target before
   deleting the selected variant's derivatives.

The existing unprotect conflict remains: an ordinary sibling with the same
content hash prevents return, rather than replacing its shared ciphertext.
Shared-original return is tracked in [#1183](https://github.com/qwts/overlook/issues/1183).
