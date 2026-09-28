# Acceptance Test: Native Application Menu

Use a packaged macOS build for the native chrome and focus checks. The automated
Electron lane covers the same command IDs in unpackaged builds without showing
test windows.

## Settings and navigation

1. Launch Overlook with an unlocked library and choose **Overlook → Settings…**.
   Confirm one Settings window opens on **General**.
2. Choose Storage & Backup, Transfer & Sync, and Privacy & Diagnostics from the
   Settings Sections submenu. Confirm each command focuses Overlook, reuses the
   same Settings instance, opens the exact pane, and remains idempotent when
   repeated.
3. Repeat from a lightbox and while another modal is open. Confirm incompatible
   overlays close and no duplicate window or dialog remains.
4. Choose All Photos, Favorites, Recent Imports, and Trash. Confirm the route and
   checked menu state follow the focused window.

## Window lifecycle and lock

1. Repeat a Settings-section command while the window is minimized, hidden, and
   the app is inactive. Confirm the existing primary window is restored and
   focused without creating another window.
2. Close the last window without quitting Overlook, then choose Privacy &
   Diagnostics. Confirm exactly one primary window is created and the queued
   route opens once after renderer readiness.
3. Configure app lock, lock Overlook, and inspect the menu. Confirm Import,
   photo, selection, and protected route commands are disabled; Settings,
   Privacy & Diagnostics, Help, and Quit reveal no library names or counts.
4. Choose Privacy & Diagnostics while locked. Confirm protected content remains
   absent. Unlock and confirm the pending route opens Privacy exactly once.
5. Start incompatible provider work and confirm Import is disabled. Attempt any
   stale invocation and confirm main-process revalidation refuses it.

## Platform and accessibility

1. Confirm macOS ordering: Overlook, File, Edit, View, Photo, Window, Help; OS
   roles retain native names and behavior, and Settings displays Command-comma.
2. Focus an editable field and confirm Select All remains the native text-editing
   role. Move focus to the gallery and confirm Select All targets the collection.
3. Traverse every renderer destination by keyboard after menu invocation and
   confirm focus is not lost behind a closed overlay.

## Windows/Linux Overlook menu (#1293)

Windows and Linux have no native menu bar (ADR-0024 §5). The titlebar ⋯
**Overlook menu**, left of Help, carries the macOS File, Edit, View, and
Overlook commands that have no other visible surface there. Use packaged
Windows and Linux builds.

1. Confirm the ⋯ button sits left of Help, is 44×30, and is named "Overlook
   menu". The toolbar shows Import as its only primary action: no Transfer &
   Sync or Export All Unencrypted.
2. Open ⋯ by pointer, Enter, Space, and ↓ (first item) and by ↑ or End (last
   item). Confirm the File · Edit · View · Overlook headings are read as group
   names, are not focus stops, and have a rule between groups. Items read their
   shortcuts (Ctrl+Z, Ctrl+Shift+Z, Ctrl+A) and match the macOS menu's labels.
   Import Photos… and Settings… show no shortcut: their ⌘I and ⌘, are macOS
   menu accelerators, and Ctrl+I and Ctrl+, do nothing here.
3. Choose Settings…. The menu closes, focus returns to ⋯, and Settings opens;
   closing Settings returns focus to ⋯. Esc and Tab close the menu without
   acting, with focus on ⋯.
4. Open a protected album. Export All Unencrypted stays in the menu, focusable
   but disabled, and a screen reader reads "Not available while a protected
   album is open". With pCloud off, Transfer & Sync is absent; without an app
   lock, Lock Now is absent.
5. Repeat at 200% zoom and in an RTL locale: the menu stays inside the window
   and mirrors to the near edge.
