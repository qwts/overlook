# Finder Library Document and Quick Look Acceptance Test

Issue: [#799](https://github.com/qwts/overlook/issues/799)

## Automated contract

- Treat only `.overlooklibrary` packages containing both `library.db` and a well-formed existing `library-id` as Finder-openable libraries. Never mint identity during document routing.
- Register an unknown valid package. Repair a known identity to a new path only when its registered path is missing; reject a second live location with the same identity.
- Keep arbitrary registered legacy directories in place. Add the package suffix only to an explicitly selected new-library destination.
- Publish one bounded, strict `OverlookSummary.json` containing only the display name, ordinary item count, and update time. A summary write failure cannot interrupt the encrypted library mutation.
- Build the Quick Look preview as a sandboxed extension that reads only that summary. It has no database, Keychain, app-group, iCloud, custody, or content access.

## Signed packaged macOS check

1. Install the signed and notarized build. Create a custom library and confirm Finder presents one `.overlooklibrary` package with the Overlook icon instead of exposing its contents.
2. Double-click the package while Overlook is closed, open, and showing another library. Confirm the matching library opens and the primary window receives attention. Confirm ordinary photo files still enter the import review flow.
3. Move the package while Overlook is closed, then double-click it. Confirm the registry repairs the missing old path and opens the moved library. Copy the package so both locations exist and confirm Overlook refuses the duplicate identity without changing either package.
4. Try an empty package, a package without `library-id`, a malformed identity, a missing package, and a library locked by another Overlook instance. Confirm each fails clearly without creating files or silently opening another library.
5. Select the package and press Space. Confirm Quick Look shows only library name, ordinary item count, and update time. Rename the library and add/delete ordinary photos; confirm the static summary refreshes. Lock Overlook and confirm Quick Look reveals no thumbnails, filenames, albums, protected counts, metadata, keys, or custody state.
6. Register and open an existing legacy library directory without the suffix. Confirm its path is unchanged and no migration or package rename occurs.
7. Upgrade the signed app and repeat double-click and Quick Look. Uninstall it and confirm Launch Services no longer advertises Overlook as the package owner or preview provider; library packages and their data remain untouched.

## Signing and isolation evidence

- Verify `OverlookQuickLook.appex` is embedded, signed, notarized, and identified as `com.zts1.overlook.quick-look`.
- Verify the extension claims App Sandbox only and does not claim app groups, Keychain groups, or iCloud containers.
- Verify the main bundle exports `com.zts1.overlook.library`, conforms it to `com.apple.package`, owns `.overlooklibrary`, and associates the document icon.
