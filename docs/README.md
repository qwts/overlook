# Overlook Documentation

This directory holds Overlook's canonical process, planning, and SOP
documentation. It is the source of truth: docs are versioned with the code they
describe, reviewed in the same pull request, and findable by GitHub code search
(see
[ENG-0003](https://github.com/qwts/playbook-engineering/blob/master/docs/decisions/ENG-0003-repo-is-documentation-source-of-truth.md)).

The GitHub wiki is retired. Its pages are stubs pointing here, kept only so
existing links resolve — never add content there.

## Layout

- [`adr/`](./adr/) — architecture decision records and their index
- [`acceptance/`](./acceptance/) — acceptance and manual test plans
- [`stories/`](./stories/) — user stories and milestone planning

## Start Here

- [Contributing](./Contributing.md) — contributor + agent workflow guide (canonical)
- [Repo Documentation Pointer Map](./Repo-Documentation-Pointer-Map.md) — which doc lives where

## Canonical Documentation Groups

- [Activity History](./Activity-History.md) — encrypted per-library audit timeline, privacy, backup, and retention
- [Undo and Redo](./Undo-Redo.md) — durable per-library command stacks, capability-aware replay, and the ADR-0025 contract
- [Library Management](./Library-Management.md) — multi-library registry, relocation, and disk-missing / interrupted-move repair
- [Original Preservation Policy](./Original-Preservation-Policy.md) — protected marker, deletion override, duplicate boundary, and custody invariants
- [Testing Strategy](./Testing-Strategy.md) — test lanes, coverage floors, when each lane must grow
- [Validation And Release Gates](./Validation-And-Release-Gates.md) — gate-by-gate detail, ratchet values, license and dependency policy, packaging and release/signing
- [CI Identity And Tokens](./CI-Identity-And-Tokens.md) — bot identities, token blast radius, and the branch-update/merge automation
- [Agent Golden Tasks](./Agent-Golden-Tasks.md) — the eval set an instruction or skill change cites as evidence (#718, ENG-0006)
- [E2E & Storybook Timing Audit](./E2E-Timing-Audit.md) — every wall-clock wait classified, its synchronization contract, and the shared launch/reload/teardown fixture (#630)
- [Localization Workflow](./Localization.md) — adding and reviewing catalogs, pseudo-locales, and RTL evidence
- [Architecture Decision Records](./adr/Architecture-Decision-Records.md) — ADR index + template
- [Deterministic Reviewed Sync acceptance](./acceptance/Acceptance-Test-Deterministic-Reviewed-Sync.md) — replay, conflict, tombstone, and restart evidence
- [Semantic embedding index acceptance](./acceptance/Acceptance-Test-Semantic-Embedding-Index.md) — #391 model checkpoint, encrypted lifecycle, scheduler, and packaged evidence
- [Security Review M11](./Security-Review-M11.md) — crypto/IPC/plaintext audit (#129) + accepted deviations
- [Live Local Interop Threat Model](./Live-Local-Interop-Threat-Model.md) — #543 origin, capability, replay, downgrade, and resource-exhaustion boundary
- [Live Local Interop acceptance](./acceptance/Acceptance-Test-Live-Local-Interop-Transport.md) — #543 rendezvous, capability, loopback, backpressure, and follow-up gates
- [M20 Privacy Lock, Touch ID & Protected Albums](./stories/User-Story-M20-Privacy-lock-protected-albums.md) — app-lock, biometric, recovery, and protected-domain contract
- [Protected Albums acceptance](./acceptance/Acceptance-Test-Protected-Albums.md) — #325–#329 custody, migration, leakage, lifecycle, and UI evidence
- [User Stories](./stories/User-Stories.md) — milestone / user-story planning home
- [Cloud Provider Contract Matrix](./Provider-Contract-Matrix.md) — adapter backup/restore readiness and live evidence
- [iCloud Drive provider](./iCloud-Drive.md) — macOS container identity, native bridge, provisioned signing, and smoke contract
- [iCloud Drive acceptance](./acceptance/Manual-Test-iCloud-Drive.md) — signed live contract, product checklist, evidence, and cleanup
- [Native drag-out acceptance](./acceptance/Acceptance-Test-Native-Drag-Out.md) — signed AppKit file promises, lazy custody, cancellation, and browser/native receivers (#796)
- [Apple Photos bridge acceptance](./acceptance/Acceptance-Test-Apple-Photos-Bridge.md) — explicit PhotoKit authorization, review, original/metadata preservation, and custody cleanup (#798)
- [Manual Test — M18 Cloud Disaster Recovery](./acceptance/Manual-Test-M18-Cloud-Disaster-Recovery.md) — isolated owner-run provider procedures
- [Accessibility Audit — WCAG 2.2 AA (July 2026)](./Accessibility-Audit-2026-07.md) — baseline, severity ranking, accepted exceptions (#398)
- [Manual Test — VoiceOver](./acceptance/Manual-Test-A11y-VoiceOver.md) — the screen-reader half the axe gates cannot cover
- [Visual accessibility acceptance](./acceptance/Acceptance-Test-Visual-Accessibility.md) — reduced motion, semantic contrast, 200% zoom, and native high-contrast/forced-colors behavior (#401, #651)
- [Full-display image acceptance](./acceptance/acceptance-test-full-display-image.md) — image-first chrome, transform persistence, and reset boundaries
- [Inspector follow and detached-window acceptance](./acceptance/acceptance-test-inspector-window.md) — #503 focus, paging, reattachment, and lock-boundary evidence
- [Photo metadata acceptance](./acceptance/Acceptance-Test-Photo-Metadata.md) — title, description, tag provenance, bulk editing, search, backup, and XMP export (#508)
- [GIF/WebP animated media acceptance](./acceptance/acceptance-test-gif-webp-animated-media.md) — #547 classification, poster/animation, reduced motion, and custody evidence
- [MPEG-TS video media acceptance](./acceptance/acceptance-test-mpeg-ts-video-media.md) — #548 signature classification, deterministic poster/duration, playback, and byte-faithful custody evidence
- [Context menu acceptance](./acceptance/Acceptance-Test-Context-Menus.md) — #504 selection, command parity, focus, viewport, and destructive-action evidence
- [Album reorder acceptance](./acceptance/Acceptance-Test-Album-Reorder.md) — #225 sidebar drag reordering, persistence, and alternative access
- [Manual Test — Windows ARM64 signed release](./acceptance/Manual-Test-Windows-ARM64-Signed-Release.md) — owner-run native Windows-on-ARM installer, architecture purity, and Authenticode (#683)
- [Overlook Library Format v1](./Library-Format-v1.md) — the on-disk format: layout, key hierarchy, envelope, recovery file, SQLCipher parameters
- [Spike — Multi-Platform Port](./Spike-Multi-Platform-Port.md) — iOS/iPadOS/tvOS/visionOS/Android/Windows feasibility; findings only, no decision
- [Spike — Lossless Cold-Storage Archives](./Spike-Cold-Storage-Archives.md) — measured ZIP/zstd feasibility and no-go recommendation
- [Application Menu Exposure Policy](./Application-Menu-Exposure-Policy.md) — command eligibility matrix, native hierarchy, shortcut policy, and implementation sequence
- [Keyboard Commands](./Keyboard-Commands.md) — active shortcuts, grid focus behavior, and command-registry extension rules
- [Gallery Quick Actions acceptance](./acceptance/Acceptance-Test-Quick-Actions.md) — configurable Command-hover actions, targeting, cleanup, and alternative access
- [Appearance themes acceptance](./acceptance/Acceptance-Test-Appearance-Themes.md) — Dark/Light/System live switching, first paint, native chrome, and dual-theme stories

## Maintenance Convention

- Detailed process/SOP/planning docs live **here**; root-level repo files
  (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`) stay compact
  entrypoints that link here.
- Doc updates ship **in the same pull request** as the change that makes them
  true — a change altering workflow, testing strategy, or architecture updates
  the page in the same unit of work, not after the fact.
- ADRs are appended, never rewritten; superseding decisions get a new ADR that
  links back.
