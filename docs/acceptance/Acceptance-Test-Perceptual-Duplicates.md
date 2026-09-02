# Acceptance test — Perceptual duplicate review (#650)

**Review Duplicates…** (File menu on macOS; ⌥⌘D on every platform) lists
groups of photos whose previews look alike, with the evidence for each
member, so the user can decide what to keep. Every photo is compared on this
device from its **own mid derivative** (ADR-0006: sRGB, metadata-free, the
saved edits baked in) through a versioned 64-bit difference hash computed for
the four 90° rotations, stored beside the photo as recomputable index
metadata. Matches are suggestions: the dialog never merges records, never
shares encrypted blobs and never changes custody. _Move to Trash_ is the
ordinary library delete, so a marked Original is preserved and counted, and
the pair-eligibility policy from
[Original preservation](../Original-Preservation-Policy.md#duplicate-boundary)
is applied when groups are formed — an Original never pairs with a
non-Original, and a marker change reshapes the review without a rescan.
Intentional variants (#496) share one asset and are never candidates.

Automated coverage: `tests/e2e/duplicates.spec.ts`,
`tests/library/perceptual-hash.test.ts` (fixture-backed candidate matrix),
`tests/db/fingerprints.test.ts`, `tests/library/duplicate-index-service.test.ts`,
`DuplicatesDialog.stories.tsx › Group / TrashRoutesThroughTheLibrary / Clean / StillIndexing`.

## Candidate matrix

Over the same picture (fixture `summer-landscape.jpg`), with the unrelated
`street-city.jpg` as the control:

| Case                              | Candidate | Evidence                                       |
| --------------------------------- | --------- | ---------------------------------------------- |
| Exact copy                        | yes       | 0 of 64 bits differ (Near-identical)           |
| Recompressed (JPEG quality 35)    | yes       | ≤ 2 bits (Near-identical)                      |
| Resized (320 px wide)             | yes       | within the threshold of 10 bits                |
| Rotated 90°                       | yes       | matched through the rotation set, "rotated N°" |
| Unrelated photo                   | no        | above the threshold                            |
| Original ↔ non-Original           | no        | excluded by policy, not by similarity          |
| Original ↔ Original               | yes       | eligible                                       |
| Variant family / Duplicate (#496) | no        | one asset by design                            |

## Steps

1. Start a new library and import a card holding an original JPEG, a
   recompressed and downsized copy, a copy rotated 90°, and an unrelated
   photo. **Expected:** four tiles in the grid; the comparison runs in the
   background after import without blocking the grid.
2. Press ⌥⌘D (or File → Review Duplicates…). **Expected:** the dialog shows
   "4 of 4 photos compared · 0 pending", one group of three (the original,
   the web copy, the rotated copy), each with its thumbnail, size, byte
   count and date, and an evidence line ("Near-identical · 1 of 64 bits
   differ"; the rotated copy adds "rotated 90°"). The unrelated photo is
   not listed.
3. Click _Move to Trash_ on the web copy. **Expected:** the toast reads
   "Moved landscape-web.jpg to Trash", the group shrinks to two, and the
   photo is in Trash like any other trashed photo (restorable).
4. Mark the original as Original (Inspector or Photo menu). **Expected:** the
   group disappears at once — "No possible duplicates found." — without a
   rescan: an Original never pairs with a non-Original.
5. Mark the rotated copy Original too. **Expected:** the pair is eligible
   again and reappears; both members show the Original badge and their
   _Move to Trash_ controls are disabled with the protected hint. Deleting a
   protected Original stays the library's Shift+Delete ceremony.
6. Duplicate a photo (Inspector › Variants › Duplicate). **Expected:** the
   variant never appears as a possible duplicate of its source — variants
   are one asset by design.
7. Offloaded original (manual): offload a photo that is in a group.
   **Expected:** it stays in the group — the fingerprint is over the
   derivative, which survives offload — and nothing is fetched to keep it.
8. Missing preview (manual): a photo whose derivative is not in custody
   (a deferred Duplicate awaiting its original, a failed decode).
   **Expected:** the status line counts it ("1 photo has no preview to
   compare yet") and it is compared as soon as the derivative arrives.
9. Interruption (manual): switch libraries or quit while the comparison is
   still running. **Expected:** the next open resumes from where it stopped;
   already-compared photos are not compared again.
10. Rescan. **Expected:** every fingerprint is dropped and recomputed; the
    review answers again as rows return; the groups are the same.
