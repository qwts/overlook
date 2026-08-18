# Native Drag-Out Safety Acceptance Test

Issues: [#796](https://github.com/qwts/overlook/issues/796), [#1027](https://github.com/qwts/overlook/issues/1027)

Native drag-out is disabled in production after the signed AppKit session
introduced by #796 was found to crash at drag initiation. The materializer and
native source remain for a separately reviewed redesign; they are not a shipped
capability while the production bridge reports `disabled`.

## Automated contract

- Begin a drag on one selected ordinary photo and on a multi-selection. Confirm plaintext is not opened until a receiver accepts an individual file promise.
- Confirm duplicate names receive deterministic numbered suffixes and the private Overlook selection payload remains present for internal album drops.
- Confirm missing, deleted, protected/migrating, locked, malformed, and oversized selections produce no promise.
- Confirm offloaded originals use verified ephemeral custody, release it after the promise settles, and never become durable as a side effect.
- Cancel or lock during materialization. Confirm the stream aborts, partial output is removed, native promises fail, and library shutdown waits for release.

## Signed packaged macOS safety check

1. In a signed/notarized build, click an ordinary photo and begin dragging it without leaving the Overlook window. Repeat rapidly in grid and list views. Confirm the app remains responsive and does not terminate.
2. Move ordinary photos between Overlook albums. Confirm the existing internal copy/move semantics remain intact and cancelled drags release their visual state.
3. Drag toward Finder, Safari/Chrome, Mail, and Preview. Confirm Overlook remains responsive and does not advertise or materialize a native file promise while the bridge is disabled.
4. Repeat with one selected photo, a multi-selection, an offloaded photo, and while locking Overlook. Confirm no plaintext scratch or receiver file appears.
5. Drag files from Finder into Overlook and drop a recovery key on its declared target. Confirm these independent inbound paths remain responsive.
