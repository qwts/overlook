# Application Menu Exposure Policy

This is the living command-exposure matrix for Overlook. It applies
[ADR-0024](./adr/ADR-0024-Shared-Command-Registry-And-Application-Menu.md) to
the native application menu, keyboard shortcuts, context menus, and gallery
Quick Actions. Update this page whenever a command is added to or removed from
one of those surfaces.

## Current baseline

Overlook installs a native application menu projected from the typed shared
registry. The same registry drives the context-aware keyboard dispatcher and
generated `?` shortcut reference introduced by #399. The native adapter added
by #531 owns platform placement, OS roles, focused-window state, and the bounded
main-to-renderer route bridge. Context menus still duplicate labels and handlers
until #504.

## Exposure test

A command belongs in the native application menu only when all of these are
true:

1. **Platform convention or broad discoverability:** users reasonably look for
   it in an application menu, or the menu is the canonical place to learn its
   shortcut.
2. **Stable meaning:** its label and result do not change with the hovered
   object. A focused target may change, but the verb may not.
3. **Deterministic target:** the command can name its target from the active
   window, route, focus, or selection. Ambiguous multi-selection disables the
   command with a reason; it never guesses.
4. **Safe stale-state behavior:** the execution boundary revalidates lock,
   library, selection, and operation state. Renderer-reported enablement is a
   hint, not authorization.
5. **Cross-surface parity:** toolbar, shortcut, context-menu, and native-menu
   invocations use the same command ID and execution path.

Frequency alone is not enough. A frequent but object-specific command belongs
in a context menu or Quick Actions. A global but dangerous command still needs
the ceremony required by
[ADR-0023](./adr/ADR-0023-Trash-Purge-And-Destructive-Action-Ceremony.md).

## Native menu hierarchy (macOS only)

The native application menu is a **macOS-only** surface (ADR-0024 §5, amended
#699). The macOS menu below uses conventional ordering and names. **Windows and
Linux draw no native menu bar** — `buildApplicationMenuTemplate` returns an empty
template there and the controller calls `Menu.setApplicationMenu(null)` (see the
[#699 subsection](#windowslinux-no-native-menu-699)).

| Menu         | Initial commands                                                                                                                            | Notes                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overlook** | About Overlook; Settings…; Settings Sections (Storage & Backup, Transfer & Sync, Privacy & Diagnostics); Lock Now; Services; Hide/Show/Quit | Use Electron roles for standard OS commands. Settings is `Cmd+,` on macOS. Stable pane routes live in one submenu. Lock Now appears only when app lock is configured.                                   |
| **File**     | Import Photos…; Export Selection…; Switch Library…                                                                                          | Export is disabled without an unambiguous focused photo or non-empty selection. Library creation, restore, and destructive removal stay in their dedicated flows.                                       |
| **Edit**     | Undo/Redo; Cut/Copy/Paste; Select All                                                                                                       | Use OS roles for text editing. Application Select All is active only when focus is outside an editable field and a library collection owns focus.                                                       |
| **View**     | All Photos; Favorites; Recent Imports; Trash; Show/Hide Inspector; Grid/List; Enter/Exit Lightbox                                           | Navigation commands are stable. Zoom and transform commands wait for the shortcut/command registry work in #399 and #510.                                                                               |
| **Photo**    | Toggle Favorite; Add to Album…; Remove from Album; Export…; Move to Trash                                                                   | Visible only when the active route supports photos. Commands resolve the focused photo or the intentional selection and share handlers with contextual surfaces. Permanent deletion never appears here. |
| **Window**   | Minimize; Zoom; Bring All to Front                                                                                                          | Electron/OS roles only. Multi-window targeting follows the focused Overlook window.                                                                                                                     |
| **Help**     | Keyboard Shortcuts; Overlook Help; Privacy & Diagnostics                                                                                    | Help and shortcut discovery are non-sensitive. Privacy & Diagnostics routes to the Settings pane; diagnostic contents are never embedded in the menu.                                                   |

The menu does not reproduce every sidebar destination, settings control, album
operation, or background task. It exposes stable entry points and lets the
destination surface retain its own contextual workflow.

### macOS six-menu realignment (#689)

The macOS bar is the canonical surface — it is what the design system's
`components/app/MenuBar.jsx` depicts (Windows/Linux have no native menu bar in
the design). #689 rebuilt the **darwin** template to that exact six-menu spec —
**Overlook · File · Edit · View · Photo · Help**, in this order — dropping the
`#531` Window menu and flattening the Settings-sections submenu into top-level
Overlook items. Every item still projects a shared-registry command id
(ADR-0024 parity); Cut/Copy/Paste and About/Quit remain OS roles the design
mock cannot render.

New registry commands joined the menu here: `library.move` (⇧⌘M), `library.new`,
`view.sidebar.toggle`, `view.mode.feed`, `view.mode.moodboard`, plus native
exposure for `photo.export` (⇧⌘E, projected into both File → "Export Selection…"
and Photo → "Export…"), `selection.clear`, `photo.restore`, and
`album.membership.add`/`remove`. Their cross-surface handler wiring +
target-aware enablement land in the #689 follow-up PR; until then they are
present but **disabled**, so the menu never shows an enabled item that does
nothing. `view.mode.feed`/`view.mode.moodboard` stay disabled until those views
exist (Moodboard is #515). The Help → `help.activity` item is owned by #690.

### Windows/Linux: no native menu (#699)

The design system specs the native menu for macOS only, so #699 removes it on
Windows and Linux: `buildApplicationMenuTemplate` returns `[]` there and the
controller sets no application menu (`otherApplicationMenuTemplate` is deleted).
Every command stays reachable through non-menu surfaces — the toolbar (Import,
view modes, Lock Now, Transfer & Sync), sidebar (Settings, sources, albums),
titlebar (Switch Library), and keyboard dispatcher (Undo/Redo, Select All,
inspector, favorite, trash, lightbox, shortcuts). The only commands whose sole
entry point was the menu, `help.activity` and `help.open`, move to a **titlebar
Help menu** (`TitlebarHelpMenu`): a no-drag button left of the window controls
that opens the shared `ContextMenu`, projecting the macOS Help menu from one
`HELP_MENU_ITEMS` list (Keyboard Shortcuts · Activity… · — · Privacy &
Diagnostics · Overlook Help) so the two Help surfaces cannot drift. Activity
stays a Help affordance, never a sidebar row (#690). The `Cmd+,` Settings
accelerator and the About box are accepted macOS-only conveniences (Settings
stays reachable from the sidebar gear).

The **Windows/Linux** template is unchanged (still File/Tools/Help placement per
ADR-0024 §5). Removing it to match the design — which specs no non-mac menu bar
— needs an ADR-0024 amendment and is tracked separately.

## Command exposure matrix

`Native` means eligible for the application menu. `Context` includes toolbar,
button, and object context-menu projections. `Quick` means eligible for the
configurable Command-hover surface from #532 after that feature exists.

| Command ID                     | Canonical label           | Target                        |  Native  |      Shortcut      | Context  |  Quick   | State and rationale                                                                                                        | Owner                  |
| ------------------------------ | ------------------------- | ----------------------------- | :------: | :----------------: | :------: | :------: | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `app.settings.open`            | Settings…                 | active window                 |   Yes    |      `Cmd+,`       |   Yes    |    No    | Opens General; allowed while locked without exposing library content.                                                      | #531                   |
| `app.settings.open.storage`    | Storage & Backup          | active window                 |   Yes    |         No         |   Yes    |    No    | Stable direct route in the Settings Sections submenu.                                                                      | #531                   |
| `app.settings.open.transfer`   | Transfer & Sync           | active window                 |   Yes    |         No         |   Yes    |    No    | Stable direct route; active work controls destination state.                                                               | #531                   |
| `app.settings.open.privacy`    | Privacy & Diagnostics     | active window                 |   Yes    |         No         |   Yes    |    No    | Safe route while locked; protected values remain behind the pane's authorization.                                          | #531                   |
| `app.lock.now`                 | Lock Now                  | application                   |   Yes    |  reviewed in #399  |   Yes    |    No    | Enabled only when configured and unlocked. Main process owns final authorization.                                          | #531                   |
| `library.switch`               | Switch Library…           | active window                 |   Yes    |  reviewed in #399  |   Yes    |    No    | Registry metadata is available while locked; opening protected content still requires unlock.                              | #531                   |
| `library.import`               | Import Photos…            | active library                |   Yes    |  reviewed in #399  |   Yes    |    No    | Disabled with no writable active library or during incompatible active work.                                               | #531                   |
| `library.export`               | Export Selection…         | focused photo/selection       |   Yes    |  reviewed in #399  |   Yes    |   Yes    | Disabled for empty or ambiguous targets and while locked.                                                                  | #504, #532             |
| `library.backup.run`           | Back Up Now               | active library                |    No    |         No         |   Yes    |    No    | State-heavy background action remains in the toolbar/settings; no idle menu noise.                                         | —                      |
| `library.source.all`           | All Photos                | active window                 |   Yes    |         No         |   Yes    |    No    | Stable navigation; closes incompatible overlays through the navigation contract.                                           | #531                   |
| `library.source.favorites`     | Favorites                 | active window                 |   Yes    |         No         |   Yes    |    No    | Stable navigation, not the same command as toggling one photo's favorite state.                                            | #531                   |
| `library.source.recent`        | Recent Imports            | active window                 |   Yes    |         No         |   Yes    |    No    | Stable navigation.                                                                                                         | #531                   |
| `library.source.trash`         | Trash                     | active window                 |   Yes    |         No         |   Yes    |    No    | Uses ADR-0023 vocabulary; entering Trash is non-destructive.                                                               | #531, #534             |
| `view.inspector.toggle`        | Show/Hide Inspector       | active window                 |   Yes    |        `I`         |   Yes    |    No    | Checked state follows the focused window; disabled on protected or incompatible routes.                                    | #399, #531             |
| `view.mode.grid`               | Grid                      | active window                 |   Yes    |  reviewed in #399  |   Yes    |    No    | Mutually exclusive checked state with List.                                                                                | #399, #531             |
| `view.mode.list`               | List                      | active window                 |   Yes    |  reviewed in #399  |   Yes    |    No    | Mutually exclusive checked state with Grid.                                                                                | #399, #531             |
| `view.lightbox.open`           | Open Photo                | focused photo                 |   Yes    | `Enter` after #399 |   Yes    |    No    | Enabled only for one deterministic target.                                                                                 | #399                   |
| `view.lightbox.close`          | Exit Lightbox             | active window                 |   Yes    |       `Esc`        |   Yes    |    No    | Available only in lightbox; dialogs retain Escape first.                                                                   | #399                   |
| `view.lightbox.rotateRight`    | Rotate Clockwise          | active lightbox view          |    No    |        `R`         |    No    |    No    | Transient view transform; Option/Alt invokes `rotateLeft`. Uses physical `KeyR` across layouts.                            | #510                   |
| `view.lightbox.rotateLeft`     | Rotate Counterclockwise   | active lightbox view          |    No    |     `Option+R`     |    No    |    No    | Transient inverse only; it does not mutate photo presentation metadata.                                                    | #510                   |
| `view.lightbox.flipHorizontal` | Flip Horizontally         | active lightbox view          |    No    |        `H`         |    No    |    No    | Transient view transform; Option/Alt invokes `flipVertical`. Uses physical `KeyH` across layouts.                          | #510                   |
| `view.lightbox.flipVertical`   | Flip Vertically           | active lightbox view          |    No    |     `Option+H`     |    No    |    No    | Transient counterpart only; persisted edit surfaces remain deferred to #493.                                               | #510                   |
| `selection.selectAll`          | Select All                | focused collection            |   Yes    |      OS role       |   Yes    |    No    | Text inputs keep native Select All; collection scope comes from focus context.                                             | #399                   |
| `photo.favorite.toggle`        | Add/Remove Favorite       | focused photo/selection       |   Yes    |        `F`         |   Yes    |   Yes    | Lightbox binding ships in #399; label and checked/mixed state derive from the resolved target.                             | #399, #504, #532       |
| `photo.album.add`              | Add to Album…             | photo selection               |    No    |         No         |   Yes    |   Yes    | Requires object-specific destination UI; native Photo menu may add it only after registry projection proves stable.        | #504, #532             |
| `photo.album.remove`           | Remove from Album         | photo selection/current album |   Yes    |         No         |   Yes    |    No    | Visible only in an album route; never implies file deletion.                                                               | #504, #534             |
| `photo.offload`                | Free Up Local Space…      | photo selection               |    No    |         No         |   Yes    |   Yes    | Storage/provider state is contextual and its preflight belongs in the existing workflow.                                   | #504, #532             |
| `photo.coverage.exclude`       | Keep on this device only… | photo selection               |    No    |         No         |   Yes    |   Yes    | Tier D when a provider copy exists (ADR-0033 §7); the preflight and authorization belong to the dialog, not a native item. | #506                   |
| `photo.coverage.include`       | Back up again             | photo selection               |    No    |         No         |   Yes    |   Yes    | Visible only for an excluded photo; re-enabling is an ordinary dirty row for the verified upload (ADR-0033 §5).            | #506                   |
| `photo.transfer`               | Transfer & Sync…          | photo selection               |    No    |         No         |   Yes    |   Yes    | Context and active transport state are too rich for the native menu.                                                       | #504, #532             |
| `photo.trash`                  | Move to Trash             | photo selection               |   Yes    |      `Delete`      |   Yes    |   Yes    | Lightbox binding ships in #399; Tier R execution revalidates target state.                                                 | #399, #504, #532, #534 |
| `photo.deletePermanently`      | Delete Permanently…       | Trash selection               |    No    |         No         |   Yes    |    No    | Tier D is confined to Trash and its explicit ceremony. Never a Quick Action or generic Photo-menu item.                    | #534                   |
| `trash.restore`                | Restore from Trash        | Trash selection               |    No    |         No         |   Yes    |    No    | Context-only inverse of Move to Trash.                                                                                     | #504, #534             |
| `trash.empty`                  | Empty Trash…              | Trash                         |    No    |         No         |   Yes    |    No    | Tier D and collection-wide; keep it in the Trash surface with exact-count ceremony.                                        | #504, #534             |
| `album.create`                 | New Album…                | active library                |    No    |         No         |   Yes    |    No    | Sidebar/album context owns naming and validation.                                                                          | #504                   |
| `album.rename`                 | Rename Album…             | album                         |    No    |         No         |   Yes    |    No    | Object-specific.                                                                                                           | #504                   |
| `album.delete`                 | Delete Album…             | album                         |    No    |         No         |   Yes    |    No    | Tier M; contextual ceremony must say photos survive.                                                                       | #504, #534             |
| `photo.rotate.clockwise`       | Rotate Clockwise          | focused photo                 | deferred |      deferred      | deferred | deferred | Persisted edit command; intentionally distinct from #510's transient lightbox transform.                                   | #493                   |
| `photo.flip.horizontal`        | Flip Horizontal           | focused photo                 | deferred |      deferred      | deferred | deferred | Persisted edit command; intentionally distinct from #510's transient lightbox transform.                                   | #493                   |
| `help.shortcuts`               | Keyboard Shortcuts        | active window                 |   Yes    |        `?`         |   Yes    |    No    | Opens the registry-generated overlay for the active context.                                                               | #399, #531             |
| `help.open`                    | Overlook Help             | application                   |   Yes    |         No         |   Yes    |    No    | No sensitive payload or telemetry side effect.                                                                             | #531                   |

An owner of `—` means the shipped contextual command needs no new issue from
this spike. It still joins the registry when the registry foundation lands.

## Registry and routing rules

Each descriptor has a stable ID and declares:

- localized label and optional checked-label pair;
- owning feature and execution process;
- target resolver (`application`, `window`, `route`, `focused-item`, or
  `selection`);
- allowed surfaces and optional platform restrictions;
- default shortcut expressed as semantic modifiers plus a physical-key or
  character policy;
- enablement, checked/mixed state, and a user-readable disabled reason;
- destructive tier/descriptor reference when ADR-0023 applies;
- lock, library, modal, active-work, and multi-window requirements;
- telemetry classification: none by default, event name only when separately
  reviewed, never target names, paths, search text, or library metadata.

Descriptors contain no React components, Electron objects, or service
closures. Renderer and main-process adapters resolve context and invoke the
same typed command execution boundary.

Native menu state is a snapshot for presentation, not authority. Immediately
before execution, the owning process resolves the current focused window and
target again, checks lock and operation state, and refuses stale requests.
When no window exists, only commands explicitly marked `createsWindow` may
create one; routes are queued until renderer readiness and then delivered once.

The renderer snapshot is intentionally content-free: it reports a route class,
dialog/focus class, bounded target cardinality, availability booleans, and
checked state. It never sends filenames, paths, search text, photo metadata,
library names, or secrets. Main overlays authoritative lock and active-work
state before rendering or executing a command. A loading/reloaded document is
not ready; only the latest idempotent route may wait for its readiness
handshake. Mutations are never queued.

Settings routes close conflicting dialogs and lightbox state before opening one
Settings instance. A lock-safe Settings route received while locked stays
pending in the renderer and opens only after authorization, so the lock surface
never renders protected Settings contents.

## Shortcut policy

- Use Electron roles for OS-owned editing/window/application shortcuts.
- Application shortcuts come from the registry; menu templates and the `?`
  overlay never carry independent accelerator strings.
- Prefer semantic `CmdOrCtrl` only when behavior is equivalent. Platform-only
  conventions stay platform-only.
- Character shortcuts use localized characters; position-dependent commands
  declare a physical-code policy and are tested on non-US layouts.
- Inputs, textareas, editable content, dialogs, and assistive-technology
  commands win over image commands.
- A duplicate active binding in the same context fails a registry test.

## Extensions and growth

Plugins and future features request a named slot such as `photo.afterExport`
or `help.beforeSupport`; they do not provide arbitrary menu trees. Requests
must use a registered command, declare supported platforms and context, and
pass the same exposure test. Core ordering is stable, unknown slots are
rejected, and the initial policy permits at most one contribution per plugin
per top-level menu. No extension may contribute to OS roles, destructive
authorization, lock/profile commands, or the application Quit section.

## Implementation sequence

1. [#399](https://github.com/qwts/photos/issues/399) creates the typed shared
   registry, conflict tests, focus contexts, and registry-generated shortcut
   help.
2. [#531](https://github.com/qwts/photos/issues/531) projects eligible commands
   into a native menu and implements the main-to-renderer route/state bridge,
   with acceptance evidence in
   [Acceptance Test: Native Application Menu](./acceptance/Acceptance-Test-Native-Application-Menu.md).
3. [#504](https://github.com/qwts/photos/issues/504) converts object context
   menus to registry projections and completes the contextual action matrix.
4. [#534](https://github.com/qwts/photos/issues/534) supplies ADR-0023
   destructive descriptors and ceremonies before destructive projections are
   enabled.
5. [#532](https://github.com/qwts/photos/issues/532) consumes only commands
   marked Quick-eligible; [#510](https://github.com/qwts/photos/issues/510)
   adds transform commands after persisted/transient ownership is explicit.

These existing issues cover the spike's implementation follow-ups without
creating overlapping tickets. Each must link ADR-0024 and this matrix when it
claims its slice.
