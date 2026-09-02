# Original Preservation Policy

Issue [#482](https://github.com/qwts/photos/issues/482) adds an **Original**
classification to ordinary-library photos. It is a user-declared preservation
marker, not a file-format label, custody state, or proof that a blob is a camera
source file.

## User contract

- A marked photo displays an Original badge in gallery, list, and Inspector
  surfaces.
- Normal deletion, Trash purge, and retention cleanup preserve Originals and
  report how many items were protected.
- Shift+Delete is the explicit override. A configured app password must be
  re-authenticated before the final irreversible confirmation.
- The authorization is short-lived, one-use, and bound to the active library,
  lock session, selected IDs, and their Original classifications. Any stale
  state restarts the ceremony.
- The marker is backup-relevant metadata and survives encrypted backup and
  disaster recovery. Older manifests without the field restore as unmarked.

## Duplicate boundary

Detection is deliberately outside this feature. Candidate consumers call
`duplicatePairEligible` after discovery and before storing, grouping, or
presenting a pair:

| Left         | Right        | Eligible |
| ------------ | ------------ | -------- |
| Original     | Original     | yes      |
| Original     | non-Original | no       |
| non-Original | Original     | no       |
| non-Original | non-Original | yes      |

Changing the marker emits the affected photo IDs through the targeted
`originalClassificationChanged` event so duplicate indexes can invalidate
only those candidates.

The perceptual review (#650,
[acceptance](./acceptance/Acceptance-Test-Perceptual-Duplicates.md)) is the
first consumer: it applies `duplicatePairEligible` when groups are formed
from fresh fingerprints, so a marker change drops the cached review and
nothing stale is shown, while the fingerprints themselves — which do not
depend on the marker — are left in place. Its _Move to Trash_ is the ordinary
delete, so a marked Original is preserved and counted like anywhere else.

## Custody invariants

- `photos.content_hash` remains unique.
- Import continues suppressing an exact plaintext hash before encryption.
- Separate imported originals never share encrypted blob custody.
- The policy creates no perceptual fingerprints, duplicate scanner, result
  store, or automatic merge/delete behavior. Perceptual review (#650) adds
  recomputable fingerprint rows beside the photo and a suggestions-only
  dialog; it still stores no pair results, merges nothing, shares no
  encrypted custody, and deletes only through the ordinary delete.
- Intentional variants are the explicit exception: under
  [ADR-0031 §3](./adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md#3-variants-share-custody-through-durable-references),
  independent variant identities reference one original asset rather than
  duplicating its encrypted blob. Duplicate does not copy the Original marker,
  and shared custody cannot bypass a marked variant's deletion ceremony.

Protected albums remain a separate encrypted custody domain; this ordinary
library classification does not alter their schema or migration protocol.
