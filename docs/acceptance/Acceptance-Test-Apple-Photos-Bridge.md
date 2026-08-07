# Apple Photos import/export acceptance

Issue [#798](https://github.com/qwts/overlook/issues/798), governed by accepted
[ADR-0027](../adr/ADR-0027-Native-macOS-Photo-Interoperability-And-Plaintext-Custody-Boundary.md).

Run the live section from a signed and notarized macOS package. Developer and
unsigned builds intentionally report the bridge unavailable. The operation is
foreground-only: import requests Photos read/write access, export requests
add-only access, and neither creates synchronization or background access.

## Live packaged matrix

1. Start with Photos access not determined. Open Import → Apple Photos, accept
   read access, check two items in the review list, and import. Confirm only the
   checked originals enter encrypted custody and Apple Photos is unchanged.
2. Repeat with limited access, denial, Screen Time/MDM restriction, and after
   revoking access in System Settings. Limited shows only permitted assets;
   every other state fails closed without names, thumbnails, bytes, or a stale
   review remaining usable.
3. Export one image and one video to Apple Photos. Confirm the prompt requests
   add-only access and the original filename, embedded metadata, creation date,
   and location survive where PhotoKit supports them. Overlook does not claim
   unsupported sidecar or Live Photo pairing fidelity.
4. Export an offloaded Overlook original and import an iCloud-only Photos
   original. Confirm each rehydrates under live authority, or fails without a
   partial Photos asset. Cancel during preparation and confirm
   `photokit-transfers/` owns no completed-operation plaintext.
5. Lock during import and export. Confirm current transfer work aborts or
   finishes only the already-committed PhotoKit transaction, scratch is swept,
   and no new item starts. Protected-album items are absent from export scope.
6. Confirm successful Photos exports remain in Apple Photos after Overlook
   locks or is removed; the dialog discloses that destination-owned plaintext
   is outside Overlook's cleanup guarantee.

## Automated evidence

- `tests/photo-kit/photo-kit-bridge.test.ts`: signing gate, least-privilege
  access levels, native resource APIs, and schema-validated binding callbacks.
- `tests/photo-kit/photo-kit-service.test.ts`: review binding, staging cleanup,
  selected ordinary-item scope, metadata handoff, release, and locked refusal.
- `tests/e2e/photokit.spec.ts`: deterministic fixture import/export through the
  same renderer, IPC, staging, encryption, and cleanup paths.
