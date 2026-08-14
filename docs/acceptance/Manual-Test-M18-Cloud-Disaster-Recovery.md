# Manual Test — M18 Cloud Disaster Recovery

Use this owner-only procedure to validate pCloud, Google Drive, or iCloud Drive
without putting credentials in CI or touching a real backup.

## Automated live contract

Prerequisites:

- checkout the PR/commit under test, run `nvm use`, and install with `npm ci`;
- be able to sign in to the intended pCloud test account in a browser; and
- allow a loopback callback on `127.0.0.1`.

Run:

```sh
npm run test:pcloud:live
```

Open the printed OAuth URL and approve access. The test prints its exact
isolated home, `/Overlook/<unique-ulid>`, then runs the shared object and
fresh-profile disaster-recovery contracts.

Expected evidence:

- OAuth token captured with the selected regional API host;
- two synthetic encrypted photos, bootstrap, and manifest upload and verify;
- browser-scope discovery of only that completed recovery home;
- fresh-directory restore with exact metadata, favorite, album membership,
  originals, and thumbnails;
- quota and unsafe-path behavior; and
- one passing test plus successful deletion of every file the run uploaded.

The token exists only in the test process. The test never selects an existing
library ID and never deletes a real backup. Empty ULID folders can remain
because folder deletion is not part of `StorageProvider`; they contain no test
objects and restore discovery hides them.

If the process is killed before cleanup, use the exact scratch home printed by
that run to inspect/delete only that ULID folder in pCloud. Never remove an
existing product-library folder.

Record the command, commit, API region, duration, pass/fail result, and cleanup
result on the owning issue. Do not record the OAuth URL or token.

## Google Drive live contract

Prerequisites:

- create a Google OAuth **Desktop app** client with the Drive API enabled;
- export its public client ID as `OVERLOOK_GOOGLE_DRIVE_CLIENT_ID`;
- use a test Google account that can approve the `drive.file` scope; and
- allow the random `127.0.0.1` loopback callback printed by the test.

Run:

```sh
npm run test:google-drive:live
```

Open the printed authorization URL and approve access. The test uses an
isolated library ID, then runs the same object and fresh-profile recovery
contracts as pCloud. Expected evidence is a passing env-gated test, exact
restore state, quota reporting, and successful cleanup of every created file.
Record the commit, duration, pass/fail, and cleanup result on #277; never record
the authorization URL, code, access token, or refresh token.

For release packages, store the same public client ID in the repository secret
`GOOGLE_DRIVE_CLIENT_ID`. A package built without it must report Google Drive
as unavailable rather than opening OAuth.

## iCloud Drive signed live contract

Dispatch the **Package** workflow for the exact commit under test, download and
extract its macOS ZIP, and use a macOS account with iCloud Drive enabled. The
artifact must be Developer ID signed, notarized, and provisioned for
`Z5DM34QS5U.com.zts1.overlook` and `iCloud.com.zts1.overlook`.

```sh
OVERLOOK_ICLOUD_ARTIFACT_COMMIT=<workflow-head-sha> \
  npm run test:icloud:live -- /path/to/Overlook.app
```

The packaged-only command runs the same shared object, restore-provider, and
fresh-profile disaster-recovery functions used by deterministic tests. It also
forces page-size-one pagination, coordinated replacement, placeholder
materialization, and SHA-256 verification. Four unique library ULIDs isolate
the run. Cleanup succeeds when none of those ULIDs remains discoverable;
unrelated existing libraries do not affect the result.

Attach the redacted JSON evidence and Package workflow URL to #659. Record the
commit, executable digest, signing identity, fixed app/container identifiers,
timing, contract checks, and cleanup result. Never record an Apple Account
identifier/token, local username, absolute artifact path, or container path.
The complete product checklist and recovery procedure are in
[iCloud Drive acceptance](./Manual-Test-iCloud-Drive.md).

## Product cross-machine check

1. On machine A, export the recovery key and finish a pCloud backup. Wait for
   **Backup complete**; the recovery bootstrap and manifest publish after the
   blob batch.
2. On a truly fresh machine/profile B, connect the same pCloud account, choose
   the exported key, enter its password, and discover libraries.
3. Confirm the real library is **Validated** with the expected generation,
   photo count, byte count, and album count. An in-progress blob-only folder
   and an empty contract-scratch folder must not appear.
4. Review and run restore. Confirm completion/relaunch, exact photo/favorite/
   album state, and open at least one original at full resolution.
5. Repeat after cancelling during download; the next run must report resumable
   staged work and must not redownload already verified objects.
6. Close Settings (or the restore dialog) while verify or restore is running.
   The job must keep going. The status bar shows `Verifying N / total` or
   `Restoring N / total`. Click the chip — or Settings → Restore library… —
   and land on the current step with the same `N / total`, not a fresh setup
   screen. Starting again must not be required; if the lock is still held the
   dialog reattaches instead of showing “A restore is already running.”
7. On a backup with extra missing/corrupt objects after the verify scan,
   choose **Continue with verified only**. Restore must activate the verified
   subset and list the extra gaps on the complete screen / `restore-report.json`,
   not abort with “The backup changed after verification.”

If the completed real library says **Wrong key**, compare the recovery-key
fingerprint with machine A. If it says **Corrupt**, capture the library ID and
backup audit log before retrying; do not delete the remote home.
