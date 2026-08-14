# Read-Only macOS File Provider Acceptance Test

Issue: [#797](https://github.com/qwts/overlook/issues/797)

## Automated contract

- Require explicit current consent before publishing a loopback endpoint or registering a domain. Disable removes the endpoint before eviction and domain removal.
- Accept only a rotating bearer token stored in the shared app-group container. Reject unknown routes, methods, identifiers, and tokens with the same generic unavailable response.
- Enumerate stable, traversal-free library, album, and photo identifiers. Normalize and deterministically disambiguate case-equivalent names.
- Exclude deleted and protected-migration records. Recheck unlocked state, current scope, and membership after asynchronous original retrieval, then release ephemeral custody after every streamed response.
- Reject create, rename, move, write, and delete requests. The extension has no database, iCloud, or Keychain entitlement; unsigned and unpackaged builds cannot register it.

## Signed packaged macOS check

1. Install the signed/notarized provisioned build. In **Settings → Storage & Backup → Finder access**, confirm Enable is disabled until the plaintext-cache disclosure is accepted. Enable the whole library and confirm one Overlook location appears in Finder and a standard Open dialog.
2. Confirm ordinary local photos show the expected stable names, sizes, content types, and dates. Open one through Finder and compare its bytes with an Overlook export. Confirm duplicate case/normalization-equivalent names receive deterministic numbered suffixes.
3. Enable selected-album scope. Confirm only the selected ordinary album names and their current members appear. Remove an album from the scope while a file is downloading and confirm the request fails without yielding bytes.
4. With an offloaded original, confirm Finder shows a dataless item. Open it online and confirm authorized rehydration produces the original bytes; repeat offline and during cancellation and confirm no fabricated or partial file appears.
5. Lock Overlook during enumeration and during a download. Confirm Finder receives one generic unavailable result with no names, counts, thumbnails, or bytes, and Overlook requests working-set eviction. Confirm protected albums and photos never appear.
6. Attempt rename, edit, move, create, and delete operations from Finder. Confirm every mutation is refused and the Overlook library remains unchanged.
7. Disable Finder access. Confirm the domain disappears, new requests fail, and Overlook discloses that macOS or receiving apps may retain copies. Re-enable, upgrade the app, and confirm the same domain and stable item identifiers return.
8. Quit and uninstall Overlook. Confirm its File Provider domain and app-owned endpoint state are removed. Do not claim deletion of copies retained by macOS or another application.

## Signing and isolation evidence

- Verify `OverlookFileProvider.appex` is embedded, signed, and notarized with bundle ID `com.zts1.overlook.file-provider`.
- Verify the extension claims only App Sandbox, network client, and `Z5DM34QS5U.com.zts1.overlook.file-provider` app-group access. It must not claim the main app's Keychain or iCloud identities.
- Verify the main app and extension embed distinct valid provisioning profiles and the unsigned package reports Finder access unavailable.
