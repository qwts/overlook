# Acceptance test — Backup coverage exceptions (#506)

**Keep on this device only…** (photo context menu) takes a photo out of
automatic backup and, when the provider already holds a verified copy,
removes that copy; **Back up again** returns the photo to the ordinary
verified upload. The rules are
[ADR-0033](../adr/ADR-0033-Backup-Coverage-Exceptions-And-Local-Only-Custody.md): the local
original is proven first (a cloud-only original is downloaded and verified
before anything else happens), the decision is recorded durably as
`excluding`, a manifest generation that already records the exclusion is
published, and only then is the provider object deleted — so recovery never
promises a photo the backup no longer holds. A shared encrypted original stays
with the provider while any included photo still references it (§3). A failed
delete leaves the photo "removal pending" with an `ORPHAN-REMOTE` audit line
and is retried by later runs (§6). Removing a provider copy is Tier D and
requires the `photos.remove-cloud-copy.v1` authorization; a photo with no
provider copy merely stops being backed up (Tier M).

Automated coverage: `tests/e2e/backup-coverage.spec.ts`,
`tests/backup/coverage-service.test.ts` (the §2 order, §3 retention, §6
retry, §7 tiers, §5 re-enabling over the real engine and mock provider),
`tests/backup/coverage-manifest.test.ts` (schema 14, restore placeholders,
verified-only projection), `tests/db/backup-coverage.test.ts` (migration 35,
the coverage machine, backup reads), `CoverageDialog.stories.tsx ›
RemovesCloudCopy / KeepsOnThisDevice`.

## Steps

1. Start a new library with the mock provider, import four photos and press
   **Back up**. **Expected:** "All backed up · now"; four encrypted originals
   in the mock remote.
2. Right-click the first photo → **Keep on this device only…**.
   **Expected:** a dialog titled **Remove the cloud copy?** that names the
   provider and account the copy will be deleted from, the byte count, and the
   side-effect sentence; the confirm button reads **Remove cloud copy permanently**.
3. Confirm. **Expected:** the toast "1 photo kept on this device only"; the
   tile's status glyph reads **On this device only**; the Inspector's Backup
   line says the same with the date; the sidebar storage card shows the
   excluded bytes; the mock remote holds three originals; the Back up button
   stays hidden (an excluded photo is not pending work); the status bar's sync
   chip reads "Backed up except 1 local-only photo · now" — never "All backed
   up" while a local-only photo exists.
4. Right-click the same photo → **Keep on this device only…** is gone and
   **Free Up Local Space…** / **Restore original** are gone too; only **Back
   up again** remains. **Expected:** as stated — an excluded photo has no
   cloud copy to offload to or restore from.
5. Select a photo that was never backed up (import one with auto-backup off)
   and choose **Keep on this device only…**. **Expected:** the dialog is
   titled **Keep on this device only**, no provider line appears, and the
   confirm button reads **Keep on this device only**; nothing is deleted.
6. Duplicate a backed-up photo (#496 family), then exclude the duplicate.
   **Expected:** the preflight reports one shared original retained; the
   provider object stays because the root still references it; the duplicate
   is excluded.
7. Disconnect the provider (Settings → Backup) and try to exclude a backed-up
   photo. **Expected:** the photo is listed as skipped with the reason "cloud
   provider disconnected"; nothing changes.
8. Offload a photo (**Free Up Local Space…**), then exclude it. **Expected:**
   the dialog reports one original to download first; after confirming, the
   original is back on disk, the photo is excluded, and the provider copy is
   gone. Kill the network mid-download and repeat: the photo is reported as
   failed ("restore failed") and its state is unchanged.
9. Make the provider refuse deletes (Local mock: make the remote `blobs`
   directory read-only) and exclude a backed-up photo. **Expected:** the toast
   says the cloud copy is still awaiting removal; the status bar shows the
   removal-pending chip; the tile keeps its synced glyph; the audit log has an
   `ORPHAN-REMOTE` line. Restore write access and press **Back up**.
   **Expected:** the copy is removed and the chip clears.
10. Right-click the excluded photo → **Back up again**. **Expected:** the
    toast "Backing up 1 photo again"; the photo runs through the ordinary
    verified upload; "All backed up · now"; the mock remote holds four
    originals again.
11. Delete an excluded photo's local original from disk (outside Overlook)
    and choose **Back up again**. **Expected:** the photo is included but its
    status is the red error glyph — never a false "backed up".
12. Move an excluded photo to Trash and purge it. **Expected:** the purge
    dialog states that the photo has no cloud copy to remove; the purge
    completes without touching the provider.
13. Run a disaster recovery restore from the provider after step 3.
    **Expected:** the validated recovery preview states the deliberately excluded
    count and bytes, separately from missing-object failures. The durable
    `restore-report.json` retains those totals in `coverage`, including when
    `missing` is empty; the placeholder row appears with the red error glyph and
    the "On this device only" coverage text, and the library opens.
14. Open a library backed up before this version. **Expected:** every photo
    is included; migration 35 adds the column with its default and the
    manifest's next generation is schema 14.

## Pending removal followed by purge (#1136)

- Repeat the refused-delete scenario, move that photo to Trash, and open
  Purge. The dialog says its cloud copy may still exist because removal is
  pending. A mixed selection counts settled exclusions separately. Repeat with
  **Empty Trash**, including enough rows to span pages; its counts must match.
- Confirm purge. The photo and its local original disappear (unless a sibling
  still needs the original); migration 39 retains remote cleanup outside the
  photo and sync-ledger cascades. If source custody cannot be captured or the
  queue cannot be persisted, purge fails before removing the photo. Identity
  capture has a ten-second deadline; unbound clean integrity errors, like
  offloaded rows, cannot borrow the selected account as their source.
- Restart, restore provider access, and press **Back up**. A fresh verified
  manifest on the recorded source account must omit the queued paths before
  deletion is retried. A failed publication or delete retains the queue for
  the next backup; retry can therefore cost another manifest generation.
  Audit records use `PURGE-REMOTE-PENDING` and `PURGE-REMOTE-SETTLED`.
- Switch to another account and repeat backup: it must not delete the original
  account's queued objects. Reconnect the source account to complete cleanup.
- Keep an included duplicate while purging its pending-removal sibling. The
  shared original remains; removing that final included claim requires another
  verified publication before its queued deletion can run.

Automated coverage: `tests/library/purge-cleanup.test.ts` (atomic persistence,
restart, sharing, account mismatch and late queue entries),
`tests/backup/backup-engine.test.ts` (publication failure and retry ordering),
and `PurgeConfirm.stories.tsx` (pending, settled and mixed counts).

### Restore byte-boundary regression (#1233)

Restore an exclusions-only backup: activation must retain its placeholder row
without generating thumbnails or verifying an absent original, and report
zero recovered photos. Repeat with one included photo: its bytes must still
verify and count as recovered. Remove that included original and verify it
remains a missing-object failure, distinct from the excluded placeholder.
`tests/backup/restore-excluded-placeholders.test.ts` exercises all three paths.

### Recovery exclusion disclosure (#1125)

The #1125 disclosure slice is covered by `Restore library coverage /
DeliberatelyExcluded` and `tests/backup/restore-coverage-disclosure.test.ts`.
Verification, confirmation, and completion retain the exclusion count and bytes;
completion uses the activated generation, including after fallback or UI reopen.
The durable report records exclusions separately from missing objects.
Bulk placeholder cleanup and origin-specific tile/Inspector copy remain
tracked in #1125; excluded rows are kept by default.
