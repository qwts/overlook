# Photo Metadata Acceptance Test

Issue: [#508](https://github.com/qwts/overlook/issues/508)

## Automated contract

- Edit a selected photo's title, description, and tags in the Inspector. Search for the new text and tag without restarting; only matching photos remain.
- Select multiple photos. Confirm mixed values remain unchanged until edited, apply a shared tag, and verify the exact updated/unchanged/unavailable counts.
- Restart the app and confirm authored and imported metadata, effective tags, and tag suppressions survive.
- Rename, merge, and remove tags library-wide. Counts and autocomplete exclude protected or migrating photos.
- Back up and restore a library and confirm metadata values, provenance, suppression, and metadata version round-trip.
- Export with Source, Edits, and None metadata modes. Source sidecars remain byte-identical, Edits creates a separate XMP, None emits no sidecar, and original media is never rewritten.

## Packaged-build check

1. Import a photo containing IPTC keywords and an XMP sidecar. Confirm imported keywords are labeled separately from authored tags.
2. Remove one imported keyword, restart, back up, and restore. Confirm it stays suppressed while the retained source XMP remains byte-identical.
3. Add the photo to an authorized protected album. Confirm ordinary search, autocomplete, and bulk edits disclose nothing about it; unlock the protected domain and confirm its sealed metadata remains available there.
