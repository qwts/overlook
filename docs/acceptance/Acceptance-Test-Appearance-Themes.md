# Acceptance Test: Appearance Themes

Use a packaged macOS build for first-frame and native-title-bar checks. The
automated Electron and Storybook lanes cover persistence, runtime switching,
token use, and standard/high-contrast passes over both first-party themes.

## Live application

1. Launch with the default profile. Confirm the window, title-bar area, shell,
   gallery, dialogs, and Settings render in Dark without a light first frame.
2. Open **Settings → General** and select Light. Confirm the whole window changes
   immediately, including native background/title-bar chrome and any open dialog.
3. Open a photo and a protected photo. Confirm image-overlay controls stay
   legible while the surrounding app uses Light.
4. Select Dark and confirm every surface returns immediately without reopening
   the window.
5. Select System, then change the operating-system appearance in both directions.
   Confirm the open window follows each change and Settings remains on System.
6. Toggle the operating-system high-contrast preference. Confirm it strengthens
   the current base appearance without changing the persisted selection.

## User themes

1. In **Settings → General → Custom themes**, import a valid
   `*.overlook-theme.json` file by picker and by drag-drop. Confirm its name,
   version, swatches, and contrast warnings appear without exposing a local path.
2. Preview the theme. Confirm its declared Dark or Light base applies beneath
   the custom color layer, the confirmation countdown is visible, and **Revert**
   restores the prior first-party or custom theme atomically.
3. Preview again and choose **Keep theme**. Quit and relaunch; confirm the custom
   theme is active on every renderer surface and remains listed as Active.
4. Import malformed JSON, an unsupported schema version, an unknown-only token
   map, an invisible body/surface pair, and values containing `var()`, `url()`,
   `@import`, or declaration punctuation. Confirm each is refused with precise
   paths/messages and the current UI remains unchanged.
5. Import a theme below 4.5:1 but above the 1.5:1 hard floor. Confirm warnings
   name every failing pair and ratio before the theme can be kept.
6. Remove the active custom theme. Confirm the previously selected first-party
   appearance returns. Delete an active theme file outside the app and relaunch;
   confirm Overlook skips it, clears the stale pointer, and displays a notice.

## Recovery paths

1. While a preview is open, let the countdown expire. Confirm the prior theme
   returns and relaunch does not apply the previewed theme.
2. Repeat while terminating or stalling the renderer before its health
   acknowledgement. Confirm main does not persist the preview.
3. From native chrome choose **View → Reset Appearance** (also verify
   Command/Control+Option/Alt+Shift+R). Confirm the profile changes to Dark with
   no custom theme, including while the renderer is locked or unreadable.
4. Launch once with `--reset-theme`. Confirm Dark loads with no custom theme even
   when the prior persisted file is malformed. This flag and the native command
   must not depend on renderer IPC cooperation.
5. Enable OS high contrast and Windows forced colors while a custom theme is
   active. Confirm system accessibility colors override user-theme values.

## Persistence and first paint

1. Select Light, quit, and relaunch. Confirm the initial native window background
   and first renderer frame are light; no dark rectangle or title-bar flash appears.
2. Repeat with Dark.
3. Leave System selected, relaunch once under each operating-system appearance,
   and confirm the first frame matches the resolved mode.

## Storybook and accessibility

1. Run Storybook and use the appearance and contrast toolbars to inspect Dark,
   Light, Dark/High Contrast, and Light/High Contrast on shell, grid, lightbox,
   dialogs, Settings, and protected stories.
2. Run `npm run test:stories:ci`. Confirm every non-exempt story is audited in
   all four variants against the checked-in WCAG 2.2 AA budget.
3. Run `npm run lint:colors`. Confirm renderer component CSS containing a raw
   color literal fails while token-source files remain the only color authority.
4. Run `npm run lint:contrast`. Confirm text, status, selection, border, focus,
   pressed, destructive, and photo-chrome pairs meet their declared floors.
