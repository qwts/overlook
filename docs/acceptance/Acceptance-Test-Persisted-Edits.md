# Acceptance Test: Persisted Edits

Covers persisted edits (#493, ADR-0031 §2 and §7–§8): a rotation, flip, or
crop made in the lightbox can be saved as an immutable **edit revision**. The
original file is never modified — every save appends a small document to the
photo's history and moves the photo's head pointer in the same transaction;
the thumbnail and preview are re-baked from the original with the head's
transform; Reset and Revert are new revisions, so history only grows.
Revisions ride in backups (manifest schema 11, library schema 31) and restore
unchanged. A revision written by a newer version of Overlook is kept and shown
view-only rather than dropped or rewritten.

The Electron lane proves save, the re-baked tile, reopen, the Inspector's
Edits section, Reset, and Revert over the seeded library. The unit lanes prove
the document format (parse, fail-closed, fold), the repository (chain, head,
cascade, restore), the service (no-op on equal stacks, deferred and failed
bakes), the worker's transform baking, and the schema-11 manifest. Use a real
library with a few local photos, at least one offloaded photo, and a backup
provider configured for the steps below.

## Editing and saving

1. Open a photo in the lightbox. Confirm the edit controls sit beside the zoom
   cluster: **Crop**, **Save edits**, **Reset edits**, **Revert**. Confirm
   Save and Reset are disabled and Revert is disabled (no history yet).
2. Rotate the photo with the orientation controls (or the keyboard). Confirm
   **Unsaved edit** appears, Save becomes the primary button, and Reset is
   enabled. Page to the next photo and back: confirm the rotation is gone
   (a draft is never persisted by itself).
3. Rotate again and press **⌘S** (or click **Save edits**). Confirm the label
   settles, Save disables, the status bar's pending count increments, and the
   grid tile behind the lightbox repaints rotated without the grid reloading
   (scroll position and selection stay).
4. Close and reopen the photo. Confirm it opens rotated, with Save disabled.
   Relaunch the app and open it again: confirm the same.
5. Flip the photo horizontally, save, then rotate once more and save. Open the
   Inspector (**I**) and confirm the **Edits** section lists **Revisions 3**
   and an **Applied** line that names the rotation and the flip.

## Crop

6. Press **C**. Confirm the whole (oriented) image is shown with a crosshair
   surface over it and the toolbar switches to **Apply crop (Enter)**,
   **Cancel crop (Esc)**, and **Clear crop**.
7. Drag a rectangle over part of the image. Confirm the rectangle is lit and
   the rest of the image is dimmed. Press **Esc**: confirm the crop is
   discarded and the view returns to the previous framing.
8. Press **C**, drag a rectangle, press **Enter**. Confirm the lightbox now
   fits the framed region only, and **Unsaved edit** shows. Press **⌘S**.
   Confirm the grid tile repaints showing only the framed region.
9. Reopen the photo and rotate it. Confirm the crop turns with the image (the
   same pixels stay framed). Save; confirm the Inspector's **Applied** line
   names the rotation and **Cropped to …%**.
10. Press **C** again, click **Clear crop**, then **Apply crop**. Save and
    confirm the tile shows the full (rotated) image again.

## Reset and Revert

11. Click **Reset edits**. Confirm the photo returns to the original
    orientation and framing, the tile repaints, and the Inspector's
    **Revisions** count grows by one (Reset is a revision, not a deletion).
12. Click **Revert**. Confirm the photo returns to the state before the reset
    and the count grows by one again. Click **Revert** repeatedly: confirm each
    step returns to the previous revision and the button disables at the
    empty root.
13. With a local, unsaved draft (rotate without saving), click **Reset edits**.
    Confirm only the draft is discarded when the head is already the original
    (no new revision), and a revision is written when it is not.

## Originals, derivatives, and failures

14. Verify with the file's checksum (or an export of the original) that the
    original bytes are unchanged after every step above.
15. Offload a photo's original, open it, rotate, and save. Confirm the amber
    toast says the thumbnails update once the original is local again, the
    revision is still saved (reopen shows the rotation), and after the
    original returns the tile re-bakes.
16. Newer format: with the app closed, insert an `edit_revisions` row whose
    document carries an operation of a type or version this build does not
    know, pointed to by the photo's `edit_head`. Open the photo: confirm the
    **Edited with a newer version** notice, the original is shown, the edit
    controls are disabled, and the Inspector's **Applied** line reads
    **Newer format — view only**. Confirm nothing rewrites the row.

## Backup and restore

17. Run a backup. Confirm the manifest is schema 11 and carries an
    `editRevisions` entry per revision with `current` set on each head.
18. Restore the backup into a fresh library. Confirm every edited photo opens
    on its head, the Inspector shows the same revision counts, and Revert
    walks the same history. Confirm a corrupted `editRevisions` entry (a parent
    from another photo, two heads for one photo) fails the restore with a
    clear error rather than a partial library.
19. Restore a schema-10 backup (taken before this feature). Confirm every
    photo opens with no edits and the Inspector shows **Revisions 0**.
