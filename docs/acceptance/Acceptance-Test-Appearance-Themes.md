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
