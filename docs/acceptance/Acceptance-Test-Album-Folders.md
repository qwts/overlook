# Acceptance Test: Album Folders and Organizational Tags

Covers album folders, inherited visibility, organizational tags, and the
folder deletion ceremony from
[ADR-0030 §1, §2, §5](../adr/ADR-0030-Collections-Visibility-Saved-Queries-And-Gallery-Inclusion.md)
(#505). The Electron lane proves that folders nest albums, that a folder's
All Photos policy is the default for children that have not set their own,
that disclosure state survives a relaunch, and that deleting a non-empty
folder names exactly the structure it removes; the unit lane proves the
depth bound, cycle rejection, sibling ordering, tag vocabulary, and the
manifest round trip. Use a real library with a few albums for the steps
below.

## Structure

1. Press the folder button next to the **Albums** heading, name a folder,
   and confirm it appears in the sidebar with an open-folder icon.
2. Open the folder's actions menu and choose **New album inside…**. Confirm
   the album appears indented one step under the folder, and that the folder's
   count is the number of distinct photos across every album inside it.
3. Open an existing album's actions menu, choose **Move to folder…**, and pick
   the folder. Confirm the album lands last among the folder's children and the
   toast names the destination. Move it back to **Top level** and confirm it
   returns to the end of the top-level list.
4. Use **Move up** / **Move down** (and ⌥↑ / ⌥↓ on the handle) on an album
   inside a folder. Confirm it only trades places with its siblings, never
   leaves the folder, and that moving the folder itself carries its children.
5. Nest folders inside folders. Confirm the seventh level is refused (the
   depth bound is six levels below the top) and that a folder cannot be moved
   into itself or into any folder inside it.

## Visibility

1. Choose **Hide from All Photos** on a folder. Confirm every album inside it
   that had not set its own policy is marked hidden, All Photos and its count
   shrink by exactly their photos, and each such album's menu says
   **Follows the folder setting**.
2. Choose **Show in All Photos** on one of those albums. Confirm only its
   photos return, and that **Use folder setting** now appears and, when
   chosen, hides them again.
3. Hide an album explicitly, then move it into a visible folder. Confirm it
   stays hidden (an explicit setting wins); move a visible album into a hidden
   folder and confirm it adopts the folder's policy.

## Disclosure and tags

1. Click a folder row to collapse it. Confirm its children disappear from the
   sidebar, All Photos is unchanged, and the folder is still collapsed after
   relaunching. Switch libraries and confirm the other library's folders keep
   their own disclosure state.
2. Choose **Tags…** on a folder or album, enter a few comma-separated tags with
   mixed case and duplicates. Confirm the menu lists them once each, that a
   photo's keywords are unaffected, and that removing a tag from every
   collection drops it from the vocabulary.

## Deletion ceremony

1. Choose **Delete folder…** on an empty folder. Confirm the dialog says
   nothing else is removed.
2. Choose **Delete folder…** on a folder with albums and sub-folders. Confirm
   the dialog offers **Move its contents to** (top level or another folder
   outside it) and **Also delete N folders and M albums inside it** with the
   exact counts, that photos are never among the counts, and that the copy
   states photos stay in the library.
3. Take the move path and confirm the children now sit under the chosen
   destination with the same order. Take the recursive path on another folder
   and confirm every photo is still in the library, hidden albums' photos
   return to All Photos, and the toast repeats the counts.

## Persistence

1. Build a tree with a hidden folder, an inheriting album, an explicitly
   hidden album, and tags. Run a backup, restore into a fresh profile, and
   confirm the same tree, the same policies, the same tags, and the same All
   Photos rows. Sidebar disclosure state is not expected to carry over.
