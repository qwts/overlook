# Keyboard Commands

Overlook's keyboard commands come from the shared registry in
`src/shared/commands/registry.ts`. The `?` overlay is generated from that
registry and shows only commands active in the current surface.

## Library

| Action                   | Shortcut     |
| ------------------------ | ------------ |
| Focus search             | `Cmd/Ctrl+K` |
| Select all loaded photos | `Cmd/Ctrl+A` |
| Clear selection          | `Esc`        |
| Show or hide Inspector   | `I`          |
| Show keyboard shortcuts  | `?`          |

Photo focus is roving: only one tile is in the Tab order. Arrow keys move by
cell or row, Home/End move to the row boundary, and Page Up/Page Down move by a
viewport. Shift plus a movement key extends the selection; Space toggles the
focused photo; Enter opens it. A normal selection establishes the range anchor;
Shift-click and Shift-keyboard selection replace the selection with the
inclusive range in the complete active gallery projection, including
virtualized photos that are not mounted. The skip link moves directly to the
grid.

## Albums

| Action                              | Shortcut                       |
| ----------------------------------- | ------------------------------ |
| Move focused album earlier / later  | `Option+Up` / `Option+Down`    |
| Grab or drop focused reorder handle | `Space` or `Enter`             |
| Move a grabbed album                | `Up` / `Down` / `Home` / `End` |
| Cancel a grabbed move               | `Esc`                          |

The expanded sidebar exposes a dedicated reorder handle after each ordinary
album row. The collapsed sidebar hides handles; `Shift+F10` or right-click opens
the same Move up/down/top/bottom commands. Protected albums are not reorderable.

## Lightbox

| Action                              | Shortcut         |
| ----------------------------------- | ---------------- |
| Previous / next photo               | `Left` / `Right` |
| Exit lightbox                       | `Esc`            |
| Show or hide Inspector              | `I`              |
| Toggle favorite                     | `F`              |
| Move to Trash                       | `Delete`         |
| Zoom in / out / reset               | `+` / `-` / `0`  |
| Rotate clockwise / counterclockwise | `R` / `Option+R` |
| Flip horizontally / vertically      | `H` / `Option+H` |
| Reset orientation                   | `Shift+R`        |

When a zoomed image overflows the viewport, arrow keys pan it before they
navigate between photos. Dialogs and editable controls always retain keyboard
precedence. Closing a dialog restores focus to its invoker.

## Adding a command

Give it a stable command ID, localized label, active surfaces, and one canonical
binding. Add any layout-equivalent character variants as alternate keys. The
registry conflict test must remain empty; do not copy shortcut strings into
menus, help, or feature components.

Rotate and flip use the physical `R` and `H` keys, so their positions remain
stable on non-US layouts. Option (Alt on Windows/Linux) invokes the natural
counter-action. These commands alter only the current lightbox view; persisted
photo edits remain owned by #493.
