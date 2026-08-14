# M05: Import pipeline

**Epic:** [#40](https://github.com/qwts/photos/issues/40) · **Lane:** Lane B — Core

Lane B. Real import from an SD card or folder: volume detection with new-vs-total counting, EXIF extraction, thumbnail generation (RAW via embedded preview for v1), copy-or-move semantics (**Move deletes from source only after verified import** — the design shows an inline amber warning), encrypt-on-import (always on), all with the per-stage progress the ImportDialog renders (copy+encrypt bar, thumbnails bar, mono `n / total` counts).

## Issues

| #                                                 | Title                                                                       | Blocked by              |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------- |
| [#83](https://github.com/qwts/photos/issues/83)   | ADR-0006: media processing — thumbnails, EXIF, RAW policy, native modules   | —                       |
| [#84](https://github.com/qwts/photos/issues/84)   | Volume/folder detection with new-vs-total counting                          | #83, #49                |
| [#85](https://github.com/qwts/photos/issues/85)   | EXIF/metadata extraction module                                             | #83                     |
| [#86](https://github.com/qwts/photos/issues/86)   | Thumbnail generation worker with RAW embedded-preview fallback              | #83, #67, #70           |
| [#87](https://github.com/qwts/photos/issues/87)   | Import engine: copy/move + encrypt + record, crash-safe, per-stage progress | #84, #85, #86, #69      |
| [#88](https://github.com/qwts/photos/issues/88)   | ImportDialog: options → running (dual progress) → done                      | #87, #59, #60, #61, #62 |
| [#89](https://github.com/qwts/photos/issues/89)   | Recent-imports source + import completion toast                             | #87                     |
| [#90](https://github.com/qwts/photos/issues/90)   | E2E: fixture SD-card import end-to-end                                      | #88, #89, #76           |
| [#500](https://github.com/qwts/photos/issues/500) | Repair missing dimensions and orientation for every decodable format        | #85, #86, #87           |
| [#489](https://github.com/qwts/photos/issues/489) | Allow verified Move for approved local-folder imports                       | #87, #237               |

## Acceptance coverage

| Flow                                                                                                                                       | Status           | Coverage                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Source discovery + scan (volumes, allowlist, SHA-256 dedupe, progressive counts)                                                           | ✅ #84 (PR #174) | `tests/import/source-scanner.test.ts`                                                                                               |
| EXIF extraction (never-fabricate, RAF embedded preview, floating wall-clock takenAt)                                                       | ✅ #85 (PR #176) | `tests/import/exif.test.ts`                                                                                                         |
| Thumbnail worker pool (sharp WebP derivatives, metadata stripped, crash-safe, encrypted at rest)                                           | ✅ #86 (PR #182) | `tests/import/thumbnail-pool.test.ts`                                                                                               |
| Import engine (journal resume, per-file Move verify-then-delete, dual progress, serialization)                                             | ✅ #87 (PR #183) | `tests/import/import-engine*.test.ts` (kill-test matrix + real-store integration w/ orphan scan)                                    |
| ImportDialog options/running/done, verbatim copy + Move warning                                                                            | ✅ #88 (PR #184) | `ImportDialog.stories.tsx` play tests + `tests/e2e/import-flow.spec.ts` — ledger id `m05-import-dialog`                             |
| Completion toast (exact counts, Show action, 4s dismiss) + Recent imports jump                                                             | ✅ #89 (PR #185) | `tests/library/app-state.test.ts` + `tests/e2e/import-flow.spec.ts` — ledger id `m05-recent-imports-toast`                          |
| Full path in CI: fixture card in → encrypted library out (no-plaintext scan, Move source emptied post-verification, Cancel semantics)      | ✅ #90 (PR #186) | `tests/e2e/import-flow.spec.ts`                                                                                                     |
| Approved-folder Move: main-side provenance, fresh consent, exact moved/retained counts, active-library refusal, verified per-file cleanup | ✅ #489          | `tests/import/import-engine.test.ts`, `tests/import/import-service.test.ts`, `tests/import/source-scanner.test.ts`, Storybook + E2E |
| Format-neutral dimensions: orientation-normalized metadata, authoritative decoder values, one-time legacy repair, and mismatch diagnostic  | ✅ #500          | `tests/import/exif.test.ts`, `tests/import/thumbnail-pool.test.ts`, `tests/db/library-db.test.ts`, `tests/e2e/export-flow.spec.ts`  |

Notable: the #90 E2E caught a real fresh-profile bug (photos.key_id FK row only written by the dev seed) — fixed in library bootstrap.

## Definition of done

See the epic issue [#40](https://github.com/qwts/photos/issues/40) — the epic body is canonical; this page is the planning index entry.
