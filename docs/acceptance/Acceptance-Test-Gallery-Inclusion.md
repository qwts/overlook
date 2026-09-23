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
The explicit local-file Recover original command, UI, and browser acceptance
remain required follow-up work under #1101.

Remote-only duplicate variants authenticate shared originals against their retained
asset owner. Valid ciphertext must leave root, duplicate, and duplicate-of-duplicate
rows available; damaged ciphertext must still record missing-original evidence.
