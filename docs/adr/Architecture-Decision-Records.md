# Architecture Decision Records

Canonical architecture decision records for photos. ADRs live in `docs/adr/`
in this repository. They are appended, never rewritten — a superseding
decision gets a new ADR that links back to the one it replaces.

## Index

| ADR                                                                                          | Title                                | Status   |
| -------------------------------------------------------------------------------------------- | ------------------------------------ | -------- |
| [ADR-0001](./ADR-0001-Automation-Check-Governance.md)                                        | Automation Check Governance          | Accepted |
| [ADR-0002](./ADR-0002-Versioning-Policy.md)                                                  | Versioning Policy                    | Accepted |
| [ADR-0003](./ADR-0003-Desktop-Stack.md)                                                      | Desktop Stack                        | Accepted |
| [ADR-0004](./ADR-0004-Encryption-And-Key-Management.md)                                      | Encryption & Key Management          | Accepted |
| [ADR-0005](./ADR-0005-Library-Data-Model.md)                                                 | Library Data Model                   | Accepted |
| [ADR-0006](./ADR-0006-Media-Processing.md)                                                   | Media Processing                     | Accepted |
| [ADR-0007](./ADR-0007-Backup-Format-And-Offload.md)                                          | Backup Format & Offload              | Accepted |
| [ADR-0008](./ADR-0008-Recovery-Key-Format.md)                                                | Recovery-Key Format & KDF            | Accepted |
| [ADR-0009](./ADR-0009-Cloud-Recovery-Bootstrap-And-Manifest-V2.md)                           | Cloud Recovery Bootstrap             | Accepted |
| [ADR-0010](./ADR-0010-Cloud-Restore-Staging-And-Atomic-Activation.md)                        | Cloud Restore Activation             | Accepted |
| [ADR-0011](./ADR-0011-Provider-Catalog-Capabilities-And-Switching.md)                        | Provider Catalog & Switching         | Accepted |
| [ADR-0012](./ADR-0012-Continuous-Backup-Integrity-And-Recovery-Repair.md)                    | Continuous Backup Integrity          | Accepted |
| [ADR-0013](./ADR-0013-App-Lock-Key-Release-And-Protected-Albums.md)                          | App Lock & Protected Albums          | Accepted |
| [ADR-0014](./ADR-0014-Image-Trail-Bidirectional-Interoperability.md)                         | Image Trail Interoperability         | Accepted |
| [ADR-0015](./ADR-0015-Deterministic-Reviewed-Sync-Journals.md)                               | Deterministic Sync Journals          | Accepted |
| [ADR-0016](./ADR-0016-Isolated-Encrypted-Interop-Transports.md)                              | Isolated Interop Transports          | Accepted |
| [ADR-0017](./ADR-0017-Multi-Library-Registry-Keying-And-Lifecycle.md)                        | Multi-Library Registry & Lifecycle   | Accepted |
| [ADR-0018](./ADR-0018-Semantic-Search-And-Language-Model-Architecture.md)                    | Semantic Search & LLM Architecture   | Accepted |
| [ADR-0019](./ADR-0019-User-Theme-Contract.md)                                                | User Theme Contract                  | Accepted |
| [ADR-0020](./ADR-0020-Internationalization-Architecture.md)                                  | i18n Architecture                    | Accepted |
| [ADR-0021](./ADR-0021-Opt-In-Crash-Diagnostics-Privacy-Boundary.md)                          | Crash Diagnostics Privacy Boundary   | Accepted |
| [ADR-0022](./ADR-0022-Library-Relocation-And-Registry-Path-Rewrite.md)                       | Library Relocation & Path Rewrite    | Accepted |
| [ADR-0023](./ADR-0023-Trash-Purge-And-Destructive-Action-Ceremony.md)                        | Trash, Purge & Destructive Ceremony  | Accepted |
| [ADR-0024](./ADR-0024-Shared-Command-Registry-And-Application-Menu.md)                       | Shared Command Registry & App Menu   | Accepted |
| [ADR-0025](./ADR-0025-Encrypted-Activity-History-And-Capability-Aware-Undo.md)               | Activity History & Capability Undo   | Accepted |
| [ADR-0026](./ADR-0026-Video-And-Animated-Media.md)                                           | Video & Animated Media               | Accepted |
| [ADR-0027](./ADR-0027-Native-macOS-Photo-Interoperability-And-Plaintext-Custody-Boundary.md) | Native macOS Photo Interop & Custody | Accepted |
| [ADR-0028](./ADR-0028-Remote-Custody-Binding-And-Custody-Safe-Disconnect.md)                 | Remote Custody Binding & Disconnect  | Accepted |
| [ADR-0029](./ADR-0029-Authenticated-Live-Local-Interop-Transport.md)                         | Authenticated Live Local Interop     | Accepted |
| [ADR-0031](./ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md)                    | Editing, Variants & Export Boundary  | Accepted |
| [ADR-0032](./ADR-0032-Sharing-And-End-To-End-Encrypted-Collaboration.md)                     | Sharing & E2EE Collaboration         | Accepted |

## Template

New ADRs use the next sequential number and this structure:

```markdown
# ADR-NNNN: Title

## Status

Proposed | Accepted | Superseded by `[ADR-MMMM](./ADR-MMMM-Title.md)`

## Context

What forces are at play; why a decision is needed now.

## Decision

The decision, stated actively ("We will …").

## Consequences

What becomes easier, what becomes harder, what must be revisited and when.
```

Add the new ADR to the index table above and link it from any affected pages.
