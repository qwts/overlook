# User Story — M15 Import sources

Epic [#237](https://github.com/qwts/photos/issues/237): SD card / Local
folder / Dropped source picker and window drag-and-drop. Issue
[#489](https://github.com/qwts/photos/issues/489) extends the journaled Move
path to local folders and dropped entries. Coverage: ledger
`m15-import-sources-picker-and-drop` (import-flow e2e + ImportDialog
stories).

## Local Copy and Move policy

- Copy remains the safe default. A saved Move preference may preselect Move,
  but every dialog requires fresh explicit consent before the import button is
  enabled. Main also presents a native confirmation for the exact source before
  accepting a Move request; renderer state alone cannot authorize deletion.
- Move is never a filesystem rename. Each admitted file is read, encrypted,
  recorded, given required derivatives, decrypted and SHA-256 verified, then
  its exact source path is unlinked. Cleanup is per-file and journaled.
- A crash, cancellation, source mutation, verification failure, read-only
  source, permission failure, or cleanup failure may leave both copies. It can
  never leave neither copy. Results distinguish imported, moved, retained,
  duplicate, failed, and cancelled files.
- Mixed drops expand only admitted media files. Enclosing directories and
  unrelated siblings are never deletion targets. Unsupported files remain
  untouched and outside the admitted import count.
- Symbolic links and package directories are not traversed. This avoids
  deleting through aliases or importing private application/library bundles.
- Move refuses files inside the active Overlook library. Network volumes use
  the same verification boundary; disconnects and permission errors retain the
  source and resumable cleanup journal.
- Google Drive remains Copy-only because deleting provider objects is a
  separate remote-destructive contract.

## Google Drive selected-file import

Issue [#465](https://github.com/qwts/photos/issues/465) adds Google Drive as
a fourth Import source. It uses Google's desktop Picker in the system browser,
returns only the explicitly selected file IDs over the nonce-bound loopback
callback, downloads supported media into private temporary staging, and then
uses the existing dedupe, encryption, metadata, thumbnail, journal, and
auto-backup pipeline.

- Authorization is ephemeral and remains limited to `drive.file`; it neither
  reads nor replaces the configured Google Drive backup account/token.
- Imports are copy-only. Overlook never deletes the selected Drive files.
- Multiple files are supported; unsupported or unavailable selections are
  counted and skipped. Recursive whole-folder import is out of scope.
- Closing or replacing a selection discards its staging; startup removes
  abandoned staging from an interrupted prior run.
- Packaged builds embed the public Desktop OAuth client ID through
  `OVERLOOK_GOOGLE_DRIVE_CLIENT_ID`. An unconfigured build reports the source
  as unavailable without starting authorization.

Coverage: ledger `m15-google-drive-selected-file-import` (import-flow e2e,
ImportDialog story, OAuth/source/service unit tests, plus owner-run live Picker
verification).
