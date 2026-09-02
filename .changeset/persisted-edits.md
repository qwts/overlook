---
'overlook': minor
---

**Persisted edits.** Rotating, flipping, and cropping a photo in the lightbox can now be saved: **Save edits** (⌘S) writes an immutable edit revision, **Reset edits** returns to the original, **Revert** steps back to the previous revision, and **Crop** (C) opens a drag-to-frame surface applied with Enter. Edits never touch the original file — every revision is a small document appended to the photo's history, the thumbnail and preview are re-baked from the original with the saved transform, and the grid, lightbox, and Inspector (a new **Edits** section) all show the result. Revisions ride in backups (manifest schema 11, library schema 31) and restore unchanged; a revision written by a newer version of Overlook is kept and shown as view-only rather than dropped.
