# ADR-0024: Shared Command Registry and Application Menu

## Status

Accepted 2026-07-20 on issue
[#533](https://github.com/qwts/photos/issues/533). This decision governs the
command infrastructure shared by #399, #504, #510, #531, #532, and #534. The
living exposure inventory and initial menu hierarchy are maintained in the
[Application Menu Exposure Policy](../Application-Menu-Exposure-Policy.md).

**Amended 2026-07-22 on issue
[#699](https://github.com/qwts/photos/issues/699)** — §5 revised: the native
application menu is a **macOS-only** surface. Windows and Linux run frameless
with no native menu bar; the registry commands are projected onto the toolbar,
sidebar, titlebar, and keyboard, with the two otherwise menu-only Help commands
served by a titlebar Help menu. Command identity, handlers, and parity are
unchanged — only placement differs by platform. Split out of #689 / PR #698.

**Amended 2026-09-26 on issue
[#1293](https://github.com/qwts/overlook/issues/1293)** (UI-09) — §5 revised
again: Windows and Linux keep no native menu bar, but a keyboard shortcut no
longer counts as a command's only surface. A second titlebar menu, the
**Overlook menu** (⋯), projects the app-level commands that otherwise had only
a shortcut or no surface. The titlebar Help menu from #699 is unchanged.
Transfer & Sync and Export All Unencrypted leave the toolbar on every platform.
Command identity, handlers, and parity are unchanged. Spec: Overlook Design
System → _Toolbar and Window Chrome_ (Pass B), mirrored on
[#1310](https://github.com/qwts/overlook/issues/1310#issuecomment-5849085818).

## Context

Overlook currently has no native application menu and no command registry.
Global keys are an inline renderer `keydown` handler; toolbar buttons, context
menus, reducer actions, and service calls each own their labels, state, and
execution independently. That works while surfaces are few, but it cannot
support native menus, shortcut discovery, configurable Quick Actions, or
consistent destructive language without drift.

The process boundary matters. Electron owns native menus in the main process,
while selection, route, modal, and focus context live primarily in the
renderer. Copying handlers into main would fork behavior. Trusting a renderer
enablement snapshot would let stale state bypass lock, target, or destructive
checks. The registry must share identity and policy without pretending one
process owns all runtime context.

ADR-0020 anticipated this point: when an application menu lands, main becomes
a catalog consumer through the same ICU catalogs. ADR-0023 separately requires
one destructive-action descriptor registry and main-process authorization for
irreversible operations. This decision composes with both contracts.

## Decision

### 1. One typed registry defines every command

We will maintain one process-neutral registry under `src/shared/commands/`.
Every application command has a stable namespaced ID and one descriptor for
its localized label, allowed surfaces, target kind, shortcut policy, state
requirements, and destructive descriptor when applicable.

Descriptors are declarative. They contain no React components, Electron
objects, mutable state, or service closures. Main and renderer adapters supply
context and execution. Buttons may remain components, but they invoke a
registered command ID instead of duplicating command policy.

OS-owned operations such as Cut, Copy, Paste, Hide, Minimize, and Quit remain
Electron roles. They are projected beside application commands but are not
reimplemented in the registry.

### 2. Surfaces are projections, not owners

The native application menu, keyboard dispatcher, shortcut-help overlay,
context menus, toolbars, and Quick Actions project the same descriptors. A
surface may show a subset, but it may not rename, rebind, or independently
implement a command.

Eligibility is explicit per surface. A command is not added to the native menu
merely because it exists. The living policy applies platform convention,
stable meaning, deterministic targeting, stale-state safety, and
cross-surface parity before granting native-menu eligibility.

### 3. Context resolution is deterministic and revalidated

Commands target one of application, focused window, route, focused item, or
intentional selection. The focused window owns navigation and checked state.
Focused-item commands prefer an explicit lightbox/focus target; selection
commands require a non-empty intentional selection. Ambiguous targets disable
the command with a reason and never fall back silently.

Menu enablement is presentational. The executing adapter resolves context
again immediately before mutation and rechecks lock, library availability,
active work, modal state, target existence, and service authorization. Main
retains final authority for process-owned, privileged, and destructive work.
ADR-0023 ceremonies and acknowledgments remain mandatory regardless of entry
surface.

### 4. Main and renderer exchange typed state and invocation messages

The renderer publishes a bounded command-context snapshot for the focused
window: route, modal/focus class, target cardinality, and checked/availability
facts. It contains IDs and booleans, not filenames, search text, photo
metadata, secrets, or protected-domain contents.

Main uses that snapshot to render native state and sends a command ID plus
window identity when invoked. The receiving adapter re-resolves the target and
either executes, routes to the owning process, or returns a typed unavailable
result. A readiness handshake queues only idempotent route commands for a new
or restoring window; mutation commands are never queued across readiness or
unlock boundaries.

### 5. The native application menu is macOS-only

_Amended 2026-07-22 (#699) and 2026-09-26 (#1293, UI-09); supersedes the
original "native hierarchy follows each platform" text._

macOS owns a native application menu — the six-menu design-system spec
(Overlook, File, Edit, View, Photo, Help; #689). **Windows and Linux draw no
native menu bar.** On those platforms `buildApplicationMenuTemplate` returns an
empty template and the controller calls `Menu.setApplicationMenu(null)`.

Removing the menu bar must leave **no command without a visible surface**. A
keyboard shortcut is an accelerator, not a surface: every command reachable from
the macOS menu bar must also be reachable on Windows/Linux from a visible,
keyboard-operable control. The Windows/Linux placement is:

- **Toolbar:** Import, view modes, zoom, Back up, Lock Now. The toolbar holds
  library work only and never wraps (Pass B).
- **Sidebar:** sources, albums, Settings (sidebar card).
- **Titlebar library switcher:** Switch, New, and Move Library.
- **Selection pill and photo context menu:** every Photo-menu command
  (favorite, albums, export selection, trash, restore). Per §2 rule 5, object
  commands stay out of app-level menus.
- **Titlebar Overlook menu (⋯):** a no-drag button left of Help that opens the
  shared APG `ContextMenu`, projected from one shared list, `APP_MENU_ITEMS`
  (`shared/commands/app-menu.ts`). It is grouped the same way as the macOS
  menus, with visible group headings:
  - File: Import Photos…, Export All Unencrypted…, Review Duplicates…
  - Edit: Undo, Redo, Select All
  - View: Show/Hide Sidebar, Show/Hide Inspector, Open Inspector in Window,
    Reset Appearance
  - Overlook: Settings…, Storage & Backup…, Transfer & Sync… (pCloud enabled),
    Lock Now (app lock configured)
- **Titlebar Help menu (#699, unchanged):** Keyboard Shortcuts, Activity…,
  Privacy & Diagnostics, Overlook Help, from `HELP_MENU_ITEMS`.

Both titlebar menus share one `TitlebarMenu` component. Labels, enablement
(`commandEnabled`), and shortcut display (`formatShortcut`) come from the
registry. Disabled items stay present with `aria-disabled` and their reason. A
parity test fails if a non-Photo command in the macOS template is in neither
`APP_MENU_ITEMS`, `HELP_MENU_ITEMS`, nor an explicit allow-list of the other
surfaces above. Activity remains a Help affordance, never a sidebar source or
album row (#690).

Two OS conveniences stay macOS-only: the `Cmd+,` Settings accelerator (Settings
is on the sidebar card and in ⋯ on Windows/Linux) and the `role: 'about'` box
(not a registry command). Adding a `Ctrl+,` accelerator later needs the conflict
tests below.

Command identity, handlers, labels, and enablement stay constant across
platforms; only placement and OS roles vary. Application menu labels use
ADR-0020's ICU catalogs in main, and the renderer titlebar menus use the same
catalog ids. Shortcut display and native accelerators are generated from
registry bindings. Non-US layout, editable-field precedence, modal precedence,
and conflict tests are required before assigning an application accelerator.

### 6. Lock, privacy, and telemetry fail closed

While locked, menus expose only commands explicitly declared lock-safe, such
as About, Help, Settings/Privacy entry, library-registry switching, unlock,
and Quit. Checked labels, disabled reasons, and context snapshots must not
reveal library names, photo counts, selection contents, protected-album state,
or recent activity.

Command telemetry is absent by default. A descriptor may opt into a reviewed
event name, but payloads never include target names, paths, search text,
library metadata, or command-context snapshots. Diagnostic clearing and every
destructive command remain governed by their stricter ADRs.

### 7. Extension points are named and bounded

Future plugins may request documented slots using registered command IDs.
They may not submit arbitrary menu templates, shadow core IDs or shortcuts,
contribute OS roles, or extend lock/profile/destructive-authorization
sections. Unknown or over-budget slots are rejected deterministically. Core
menus remain useful when every extension is absent or disabled.

## Consequences

- **Easier:** labels, shortcuts, enablement, accessibility names, and handlers
  can be tested once and projected consistently; the native menu does not fork
  renderer behavior; shortcut help becomes generated evidence rather than a
  second list.
- **Safer:** stale native state cannot authorize a command, locked menus do not
  leak content, and destructive ceremonies remain below every surface.
- **Harder:** the registry and typed bridge must exist before #531, #504, or
  #532 can finish; focused-window snapshots require lifecycle discipline; OS
  roles and application commands need separate adapters.
- **Deferred:** persisted edit/variant commands (#510 and #493), plugin loading,
  and user-remappable shortcuts. Their future implementations must extend this
  registry rather than introduce parallel command systems.
- **Revisit when:** the app gains multiple independent content windows, a
  plugin runtime, user shortcut editing, or a non-Electron shell. The stable
  command IDs and process-neutral descriptors must survive those changes even
  if adapters and placement do not.
