# Cloud Provider Contract Matrix

Canonical status for provider-neutral backup and disaster recovery. An adapter
is not restore-ready merely because account connection or object upload works.

| Provider     | Object contract                                     | Complete fresh-profile restore | Live owner run                                                                                 | Status            |
| ------------ | --------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------- |
| Local mock   | CI                                                  | CI + Electron E2E              | Not applicable                                                                                 | Passed            |
| pCloud       | Scripted unit + shared contract                     | Shared contract                | Passed 2026-07-14 (`api.pcloud.com`)                                                           | Passed            |
| Google Drive | Scripted unit + shared contract in PR #344          | Shared contract in PR #344     | Pending owner OAuth client/account                                                             | Live gate pending |
| iCloud Drive | Scripted native authority + shared contract in #657 | Shared contract in #657        | Passed 2026-07-22 ([run 29886355588](https://github.com/qwts/photos/actions/runs/29886355588)) | Passed            |

## Account authority identity

Connection is complete only after the adapter returns and persists a stable,
non-secret account subject. Provider status exposes the label, never the
credential or subject ID. Missing identity is a typed retryable connection
failure and cannot activate the provider.

| Provider     | Stable subject                | Display label                 | Contract evidence                                  |
| ------------ | ----------------------------- | ----------------------------- | -------------------------------------------------- |
| Local mock   | `mock-account` (overridable)  | Test-overridable              | Capture, replacement, unavailable                  |
| pCloud       | `userinfo.userid`             | `userinfo.email`              | Scripted capture/change/unavailable + restart      |
| Google Drive | `about.user.permissionId`     | `about.user.emailAddress`     | Scripted capture/change/unavailable + restart      |
| iCloud Drive | Pinned ubiquity account token | OS label, or `iCloud account` | Deterministic capture/change/unavailable + restart |

## Required restore contract

Every provider must run the same `exerciseRestoreProviderContract` and
`exerciseDisasterRecoveryContract` suites. Together they prove:

- unscoped library discovery and safe library scoping;
- recovery-bootstrap, manifest, and encrypted-blob round trips with exact
  byte/checksum verification;
- a complete encrypted backup containing metadata, favorite state, album
  order, and membership;
- reconstruction into a fresh local directory with exact catalog state,
  decryptable originals, and regenerated encrypted thumbnails; and
- deletion of every remote object created by the isolated test.

The mock suite runs in normal CI. Live credentials never enter CI; provider
owner runs follow
[Manual Test — M18 Cloud Disaster Recovery](./acceptance/Manual-Test-M18-Cloud-Disaster-Recovery.md).

## Discovery invariant

`listLibraries()` advertises only provider homes containing
`recovery/bootstrap.ovrb`. A blob-only upload still in progress and an empty
test folder are not corrupt libraries and must remain hidden. Once the backup
publishes its verified bootstrap and manifest, it becomes discoverable. A
completed home opened with a different recovery master remains visible as
**Wrong key**.

Remote integrity after a successful upload is tracked separately by
[#302](https://github.com/qwts/photos/issues/302): missing or corrupted
previously-synced objects must be repaired when a local copy exists, otherwise
surfaced as unrecoverable rather than left green.
