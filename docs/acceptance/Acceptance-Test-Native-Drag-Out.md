# Native Drag-Out Acceptance Test

Issue: [#796](https://github.com/qwts/overlook/issues/796)

## Automated contract

- Begin a drag on one selected ordinary photo and on a multi-selection. Confirm plaintext is not opened until a receiver accepts an individual file promise.
- Confirm duplicate names receive deterministic numbered suffixes and the private Overlook selection payload remains present for internal album drops.
- Confirm missing, deleted, protected/migrating, locked, malformed, and oversized selections produce no promise.
- Confirm offloaded originals use verified ephemeral custody, release it after the promise settles, and never become durable as a side effect.
- Cancel or lock during materialization. Confirm the stream aborts, partial output is removed, native promises fail, and library shutdown waits for release.

## Signed packaged macOS check

1. In a signed/notarized build, drag one local photo and then several selected photos into Finder, Safari/Chrome upload, Mail, and Preview. Confirm every receiver gets the expected original bytes and unique names; Overlook retains its sources.
2. Start and cancel a drag outside every target. Confirm no plaintext scratch appears. Repeat while locking Overlook and confirm no receiver gets a file.
3. Drag an offloaded photo while online, offline, and while cancelling retrieval. Confirm only the authorized online case yields bytes and the photo remains offloaded afterward.
4. Confirm protected photos expose no native drag gesture or promise. Move ordinary photos between Overlook albums and confirm the existing copy/move semantics remain intact.
5. Quit/relaunch after completed and cancelled drags. Confirm Overlook owns no retained plaintext; files accepted by another app remain explicitly outside Overlook's cleanup guarantee.
