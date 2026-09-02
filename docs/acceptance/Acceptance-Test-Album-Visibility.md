# Acceptance Test: Album Visibility in All Photos

Covers the per-album **Show in All Photos** policy from
[ADR-0030 §2](../adr/ADR-0030-Collections-Visibility-Saved-Queries-And-Gallery-Inclusion.md)
(#494). The Electron lane proves that hiding an album removes exactly its
photos from All Photos, discloses the count, leaves the album's own view
intact, and is reversible; the unit lane proves inclusion-wins composition,
transactional flag maintenance, the rebuild sweep, and the manifest round
trip. Use a real library where at least one photo belongs to two albums for
the steps below.

## Hiding and showing

1. Open the actions menu of an album (right-click its sidebar row or use its
   actions button) and choose **Hide from All Photos**. Confirm All Photos and
   its sidebar count shrink immediately, the status bar shows "N photos hidden
   by album settings", the album row shows the hidden marker, and the library
   photo total in the status bar is unchanged.
2. Open the hidden album. Confirm every one of its photos is still there with
   the same count, and that search, Favorites, Recent imports, and export still
   include them.
3. Choose **Show in All Photos** on the same album. Confirm every photo returns
   to All Photos and the status bar disclosure disappears.

## Inclusion wins

1. Hide an album that shares a photo with a visible album. Confirm the shared
   photo stays in All Photos, and that the album's actions menu states how many
   photos stay in All Photos via other albums and offers **Open …** for each
   of those albums.
2. Hide the other album too. Confirm the shared photo now leaves All Photos.
3. Add a photo to a hidden album from the grid, then remove it again. Confirm
   the photo leaves and re-enters All Photos without a restart. Delete a hidden
   album and confirm its photos return to All Photos and are never deleted.

## Persistence

1. Hide an album, run a backup, restore into a fresh profile, and confirm the
   same album is hidden and All Photos shows the same rows. Switch libraries
   and back, and confirm the policy is unchanged.
