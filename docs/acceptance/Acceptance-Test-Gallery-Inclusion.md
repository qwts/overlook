# Acceptance Test: Gallery Sources and Inclusion Rules

Covers the derived **RAW** and **Unavailable** sources and the All Photos
inclusion rules from
[ADR-0030 §4](../adr/ADR-0030-Collections-Visibility-Saved-Queries-And-Gallery-Inclusion.md)
(#512). The Electron lane proves the RAW count, the minimum-size rule, and
its disclosure against the seeded library; the unit lane proves the derived
predicates, unknown-dimension handling, and manifest round trip. Use a real
library with damaged files for the steps below.

## Derived sources

1. Import a folder containing RAW files, a truncated JPEG, and a file whose
   dimensions the decoder cannot read. Confirm **RAW** and **Unavailable**
   rows appear in the sidebar with exact counts, paginate correctly, and that
   the RAW filter chip in All Photos selects the same items as the RAW source.
2. Open the Unavailable source. Confirm each tile states its reason (corrupt,
   unsupported codec, decode failed) or shows the unknown-dimension indicator.
3. Replace the truncated file with an intact copy of the same photo and open
   it. Confirm the item leaves Unavailable and its count drops without a
   restart or re-import.

## Explicit repair qualification

Backend qualification for explicit repair (#1098) lives in
`tests/import/targeted-preview-repair.test.ts`: a request selects one live image
(JPEG, PNG, RAW, HEIC, GIF, or WebP), including a JPEG outside the background
RAW/legacy scan. It leaves video/audio/other media untouched without loading their
originals and does not select sibling variants by shared content hash. Recorded dimension failure still
requires decode when old positive dimensions and readable previews remain.
Requests share the background pass's sequential decode queue; locked,
offloaded, trashed, absent, and closed-library targets are not decoded. Successful
repair updates Unavailable/All Photos membership without restart. The encrypted
deferred-edit test also exercises this path with a persisted rotated edit.

Video retries use `PosterCaptureService.capturePhoto` and the same bounded
offscreen queue as background poster generation. Service/runtime tests verify
exact-row selection, waiting behind background work, custody refusal, abort
before publication, and successful dimension repair without changing siblings.
An explicit successful repair refreshes membership; background capture remains
a derivative-only refresh. Audio remains preserved-only under ADR-0026.

Video repair retains uncapped decoder dimensions: a 3840×2160 source with a
2048×1152 poster must remain 3840×2160 without a false metadata mismatch. A
poster without valid decoder dimensions cannot clear unavailable dimension evidence.

With automatic backup disabled, explicitly repair a video with unknown dimensions.
Its pending-backup count updates immediately after metadata repair, without waiting
for a backup run. Background poster generation still refreshes thumbnails only.

The Inspector/context-menu entry point, typed IPC, and browser acceptance cases
remain tracked by #1098; these backend checks alone do not establish that the
user-visible action is delivered.

## Inclusion rules

1. In **Settings → General → All Photos**, set **Minimum size** to 1 MP.
   Confirm All Photos and its sidebar count shrink immediately, the status bar
   shows "N photos hidden by All Photos rules", and clicking it opens the rule.
   Items with unknown dimensions stay visible with their indicator.
2. Turn off **Show unavailable items in All Photos**. Confirm those items leave
   All Photos, remain in Unavailable, in albums, in search results, and in
   export, and that the disclosure count includes them.
3. Set Minimum size back to **None — show every size** and re-enable
   unavailable items. Confirm every row returns and no record was moved,
   deleted, or re-imported (library photo total in the status bar is unchanged
   throughout).
4. Confirm a 160×160 test image is hidden at 1 MP and shown at None.

## Persistence

1. Change both rules, run a backup, restore into a fresh profile, and confirm
   the restored library applies the same rules before any Settings visit.
2. Switch to a second library. Confirm its own rules apply and switching back
   restores the first library's rules.

### Missing-original evidence (#1101)

Consistency repair records confirmed local-original absence independently from
preview failures and transient upload errors. Legacy error rows are inspected;
a present original with an upload error remains available. The absence reason
and ledger repair commit together, and membership notifications refresh the
Unavailable and All Photos sources without restarting. The predicate remains
join-free and uses the Unavailable partial index.

Integrity scrubs use the same atomic evidence transition for verified remote
loss and healing, including legacy custody binding. Membership events occur
after commit; a failed evidence update rolls back the ledger/binding changes.

Verified original restoration clears this evidence for all sibling variants
sharing that original. Thumbnail success and an unauthenticated file appearing
at the original path cannot clear it. Independent preview debt remains.
`gallery-inclusion.test.ts` and `consistency.test.ts` cover these boundaries.
Select a missing-original row in Unavailable and choose **Recover original…**
from Inspector or its single-photo context menu. Cancel keeps the row unchanged.
A wrong file must leave the absence reason intact and publish no replacement.
The matching original returns every affected sibling to local custody and updates
All Photos/Unavailable without restarting. Excluded photos remain excluded;
independent preview or dimension failures still require their own repair.

Recovery authenticates the published envelope, including when a file already
exists. A corrupt or wrong-owner envelope is refused without overwriting it.
New ciphertext uses the active write key and retains the asset-owner identity.
After verification, all shared photo rows adopt the stored envelope key ID in
the same transaction as local-custody and absence-evidence updates. An imported
or retired read key is never used for new encryption.
Key-locked and trashed photos cannot recover. Library close cancels queued work,
interrupts the file stream, and drains before closing the database/key store.

`original-recovery.test.ts` covers shared ownership, wrong files, existing bad
envelopes, custody refusal, and close/drain. `original-recovery.spec.ts` exercises
the Inspector action through real IPC with encrypted originals, alongside a
transient upload error that remains in All Photos.

Remote-only duplicate variants authenticate shared originals against their retained
asset owner. Valid ciphertext must leave root, duplicate, and duplicate-of-duplicate
rows available; damaged ciphertext must still record missing-original evidence.

Restored excluded placeholders and explicitly missing partial-restore rows enter
Unavailable immediately when the catalog is created. Included originals without
absence evidence remain available; no later consistency scan is required.

When recovery changes the original key, existing derivative envelopes retain their
prior key reference. Verify that the old key still counts the affected photos,
requires the destructive removal ceremony, and locks those photos if removed.
Re-importing the key must authenticate an existing derivative and unlock them.
References are conservatively retained until photo purge; preview regeneration
alone does not prove every old-key envelope is gone. Failed catalog publication
rolls back key references together with availability evidence.

Recover an original shared with a backed-up, unpurged Trash sibling. The next
manifest must retain that sibling and its deletion timestamp. Its prior synced
or offloaded custody remains intact; a never-backed-up Trash sibling must not
be newly advertised as recoverable merely because a live sibling recovered.

Launch recovery from a detached Inspector. After success, its missing-original
prompt must disappear without changing selection or reopening the window. Rapid
selection changes or older in-flight reads must not replace the current record.
DOM coverage: `tests/dom/detached-inspector-photo.test.tsx`.

For an excluded live photo sharing an original with backed-up Trash, local
recovery need not replace provider ciphertext. Publish a later catalog and
disaster-restore it: the rebuilt keyring must retain the key that authenticates
the actual original, even when the catalog names the newer local key. It must
also retain the write key used for rebuilt previews. Neither key may appear
unused and permit ordinary removal. The bootstrap must still hold their material.

## Explicit per-photo repair (#1098)

For a supported image with a recorded preview or dimension failure, open its
context menu in Unavailable and choose **Retry repair**, or use the same command
in the Inspector. The action targets only that photo, including when siblings
share the original. A successful repair leaves Unavailable and returns to All
Photos without restarting; a decode failure stays visible and can be retried.
Locked photos explain the missing key; offloaded photos require original
restoration; unsupported media never enter the image decoder.

While a repair is pending, changing libraries or authorization scope must not
report success against a different library. Another queued photo's success is
not evidence for the requested photo. The IPC rereads its requested row after
the shared repair queue drains.

Coverage: `tests/e2e/gallery-inclusion.spec.ts` repairs one preview failure via
context menu and one dimension failure via Inspector over real encrypted seed
originals. IPC and DOM tests cover refusal, stale scope, pending state, and
retryable failure. Browser validation runs in hosted CI.

Keep an unavailable image selected in All Photos and retry repair from Inspector.
After success, its thumbnail must reload the regenerated derivative immediately,
without navigating away or reopening Inspector. Unrelated photo changes must not
reload it; the same event-driven thumbnail invalidation applies to detached Inspectors.
