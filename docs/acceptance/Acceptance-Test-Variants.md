# Acceptance Test — Variants (#496)

Governing contract: [ADR-0031 §1](../adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md)
(a variant is a library row over an immutable original asset), [§3](../adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md)
(Duplicate and Promote are reversible library operations; Merge is not
offered), [§7](../adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md)
(backups carry lineage and representatives), and [§8](../adr/ADR-0031-Editing-Variants-Provenance-And-Export-Boundary.md)
together with the [ADR-0023 §4 amendment](../adr/ADR-0023-Trash-Purge-And-Destructive-Action-Ceremony.md)
(what dies with a purged variant, and what waits for the last one).

A **variant** is a photo row that references an original asset by content
hash. Several variants may share one asset: one encrypted original, one
cloud copy, one set of imported sidecars — and per variant its own metadata,
edit history, album seats, and its own thumb/mid previews under its own
**derivative key**. **Duplicate** creates a sibling; **Promote** names the
family's representative. No variant operation reads the original for custody
or rewrites it.

## Where it lives

- **Context menu** on any library tile (single or multi-selection): **Duplicate**.
- **Inspector › Variants**: the family list (import or duplicate, date, the
  shown one marked), **Representative** badge, **Promote** per sibling,
  **Duplicate** for the shown photo; a row opens that variant in the lightbox.
- Storybook `App/Inspector › VariantsFamily` renders the family with a
  stubbed bridge; `tests/e2e/variants.spec.ts` drives the real app.

## Steps

1. Launch a seeded library (`OVERLOOK_SEED=2`) or import two photos. Right-click
   a tile and choose **Duplicate**. **Expected:** the toast reads "Duplicated
   1 photo", the grid shows one more tile with the same file name, and the new
   tile has a real preview. In the library page (`window.overlook.library.page`)
   the two rows share `contentHash` and differ in `derivativeKey`; the new
   row's `variantSourceId` names the source and its `assetOwnerId` names the
   row whose import sealed the original (the envelope binds that id; a root
   reports null). The blob store gained no new
   original (`blobs/` has the same object count); it gained one thumb and one
   mid derivative under the new key.
2. Select three tiles (one of them in Trash if you like) and choose
   **Duplicate**. **Expected:** the toast counts the created variants and,
   when a source was in Trash, "skipped N in Trash". Trashed sources are never
   duplicated.
3. Open the duplicate in the lightbox and press `I`. **Expected:** the
   **Variants** section shows "2 variants", both rows (the shown row reads
   "Duplicate · date · Shown" and is inert; the source reads "Imported ·
   date"), no **Representative** badge yet, and the note "One encrypted
   original · each variant keeps its own previews".
4. Press **Promote** on the source row. **Expected:** the badge moves to the
   source; the duplicate row gains a **Promote** button. Promote the duplicate
   back. **Expected:** reversible, no custody change (the backup pending count
   changes only by the manifest generation owed).
5. Press the source row. **Expected:** the lightbox shows the source and the
   Inspector follows; its row is now the inert one.
6. Save an edit (rotate) on the source, then **Duplicate** it from the
   Inspector. **Expected:** the new variant shows the rotation baked into its
   own preview, its **Edits** section lists one root revision with that
   operation, and the source's history is unchanged. Reset the source's edit.
   **Expected:** the duplicate's preview keeps the rotation — variants never
   share derivatives.
7. Favorite and mark the source as **Original**, then duplicate it.
   **Expected:** the duplicate is neither favorited nor an Original; it sits
   in every album the source is in, at the end.
8. Move the duplicate to Trash and purge it (or empty Trash). **Expected:**
   the source still opens with its preview; the encrypted original and the
   cloud copy remain; only the purged variant's previews were removed
   (`blobs/thumbs/` has no object under its key). The toast's honest sentence
   mentions kept originals when a sibling survives.
9. Move the last variant to Trash and purge it. **Expected:** the original,
   its legacy previews, its sidecars, and the cloud copy are removed — the
   ADR-0023 §4 death list, in order.
10. Back up, then restore into a fresh library. **Expected:** both variants
    return with their own derivative keys (the duplicate's previews rebuild
    under its key with its own edit baked), the original downloads once, and
    the **Representative** badge is where it was. A manifest naming a
    representative that is not a carried variant of that asset fails restore
    as corrupt rather than restoring partially.
11. Open a library last written before this version. **Expected:** migration
    33 rebuilds the photos table in place: every photo keeps its rowid, album
    seats, ledger row, and search results; every existing preview stays
    valid without regeneration (the derivative key equals the content hash).
12. Offload the original of a photo, then duplicate it. **Expected:** the
    variant exists immediately and the toast reads "1 awaiting its original
    for previews"; when the original returns, its previews bake.

## Shared companion custody (#1120)

Import a photo with XMP/AAE companions, duplicate it, then duplicate the duplicate.
Purge the importing row and the intermediate duplicate. Export the survivor in
**Original plus sidecars** mode with original metadata retained: the original and
imported companions must remain byte-identical. A consistency scan must not list
those companions as orphaned. Trashed variants still retain custody until purge.
Purge the last variant: its companion objects are now eligible for local and
remote deletion.

Back up before and after root purge, then restore the latter generation into a
fresh library. The surviving variant must still export its companions. Schema 16
records each reference's variant ID separately from the immutable ciphertext
owner ID; owner IDs can outlive their importing row. Schemas 2–15 remain readable
with their original per-photo companion identities. Migration 40 adds owner IDs
without rewriting blobs and fills existing same-owner variant references where
source companions still exist; previously deleted bytes cannot be recovered by
migration.

Also exclude a backed-up root from backup, purge it while removal is pending,
and retain an included duplicate. Publishing the exclusion and retrying cleanup
must not delete the duplicate's shared companion. Deleting the final reference
requires a fresh manifest barrier before queued remote cleanup proceeds.

## Deferred preview repair (#1121)

1. Back up a JPEG or PNG with a visible rotation/crop, then offload its original.
2. Duplicate it. Confirm the new row retains its edits and shows pending previews
   in the grid and Inspector, without replacing the source's thumbnails.
3. Restart while the original remains offloaded. The pending state must survive.
4. Restore the original to this device. Without another restart, the variant's
   previews must appear with its own saved transform. Its source stays unchanged.
5. Repeat with several siblings and a failed/cancelled repair. Debt must remain
   until authenticated previews exist or regeneration succeeds; retry after
   restoration must repair all siblings under their own derivative keys.

Schema 41 adds local preview repair debt. Older variants are checked once on
upgrade; valid authenticated derivatives satisfy that debt without decoding an
original. This local state does not change the backup manifest schema.

Pending variants appear in Unavailable and availability smart-album filters, and
are hidden by the hide-unavailable policy until repaired. A local codec/decode
failure shows its actual diagnostic instead of asking to restore the original.
