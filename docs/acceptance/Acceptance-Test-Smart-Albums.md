# Acceptance Test: Smart Albums and Facet Filters

Covers Smart Albums and the facet filter bar from
[ADR-0030 §3, §4, §6](../adr/ADR-0030-Collections-Visibility-Saved-Queries-And-Gallery-Inclusion.md)
(#514). The Electron lane proves that values within a facet are an inclusive
union, that facets compose by an explicit Match all / Match any, that a saved
Smart Album shows the same photos as the live filter that made it, survives a
relaunch, re-evaluates after an edit, duplicates beside the original, and
deletes without touching a photo. The unit lane proves that every facet
compiles to the row-by-row truth, that unknown dimensions never match a size
range, that the count and the page come from the same compiled predicate, and
that a document this version cannot evaluate is preserved and reported. Use a
real library with several cameras, a few RAW files, and some tags for the
steps below.

## Facets

1. Press **Filters** in the toolbar. Confirm a facet bar appears with one
   button per facet (File type, Megapixels, Camera, Lens, Location, Tag,
   Favorite, Custody, Availability) and the status reads **No facets**.
2. Open **Camera** and pick one value. Confirm the grid shrinks to that
   camera's photos, the button reads **Camera · 1**, and the status reads
   **1 facet**.
3. Shift-click a second camera (or tick **Add to selection** and click it).
   Confirm both values show as pressed, the grid shows the union of the two
   cameras, and the button reads **Camera · 2**. Click a pressed value with
   neither modifier and confirm it becomes the only value; click it again and
   confirm the facet clears.
4. Open **File type** and pick **RAW**. Confirm the grid shows only RAW photos
   from those cameras and the status reads **2 facets · match all**. Switch
   the segmented control to **Match any** and confirm the grid shows every
   photo from either camera plus every RAW photo.
5. Open **Megapixels**, enter a minimum, and press **Apply**. Confirm photos
   whose dimensions are unknown (an unreadable file, a repaired-later RAW) are
   never included, whatever the bounds, and the panel says so.
6. Open **Tag** and confirm the values merge photo tags case-insensitively
   with their counts, and that a keyword the photo suppressed does not match.

## Saving and opening

1. With at least one facet chosen, press **Save as Smart Album…**, give it a
   name, and optionally a folder. Confirm it appears in the sidebar with the
   funnel icon, its count equals the number of photos on screen, and the facet
   bar status now says **Editing <name>**.
2. Confirm **All Photos** and every album count are unchanged: a Smart Album
   stores the query, never the photos.
3. Quit and relaunch. Confirm the Smart Album is still listed with the same
   count, and clicking it shows the same photos with the same facets loaded in
   the bar.
4. Open a plain album or a source. Confirm the facet bar's Smart Album query
   is dropped. Choose a live facet on All Photos, then switch to Favorites, and
   confirm the live facet stays, like the filter chips.

## Editing, duplicating, deleting

1. With a Smart Album open, change a facet. Confirm the grid re-evaluates
   immediately, **Save changes** becomes enabled, and pressing it updates the
   sidebar count. Confirm no photo was added to or removed from any album.
2. From the Smart Album's actions menu confirm there is no **Hide from All
   Photos** entry (a Smart Album has no membership to hide), then choose
   **Duplicate**. Confirm a copy named **<name> copy** appears beside the
   original in the same folder with the same count and tags.
3. Choose **Delete Smart Album…** on the copy. Confirm the dialog says photos
   stay in the library and only the saved query is removed, names how many
   photos match today, and that after deleting, **All Photos** and the status
   bar total are unchanged.
4. Put a Smart Album in a folder and delete the folder with **Also delete**.
   Confirm the choice names the Smart Album count apart from albums (for
   example **1 folder, 2 albums and 1 Smart Album**) and the toast repeats it.

## Fail closed

1. Restore a backup written by a newer version whose Smart Album predicate
   carries a version this build does not know (the unit lane simulates this
   with a version-99 document). Confirm the Smart Album is still listed,
   marked as one whose saved query cannot be evaluated, shows an explanatory
   empty state instead of an unfiltered grid, and that its document is
   preserved byte for byte until you choose facets and **Save changes**.

## Backup and restore

1. Back up a library with Smart Albums (manifest schema 10), restore it into
   an empty library, and confirm every Smart Album returns with its query,
   folder placement, position, and tags, and that the restore verification
   passes.
