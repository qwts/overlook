# Accessibility Audit — WCAG 2.2 AA (July 2026)

> The baseline audit for epic [#381](https://github.com/qwts/photos/issues/381),
> produced by [#398](https://github.com/qwts/photos/issues/398). Every finding below is
> either a filed issue or an accepted exception with a rationale. The automated counts are
> frozen as a ratchet in `tests/a11y/violation-budget.json`; see
> [Testing Strategy](./Testing-Strategy.md) for the lanes and
> [ADR-0001](./adr/ADR-0001-Automation-Check-Governance.md) for the gate.
>
> **Re-run this audit** when a child of #381 lands, or when `axe-core` is bumped:
>
> ```sh
> OVERLOOK_A11Y_REPORT=/tmp/a11y.jsonl npm run test:stories:ci
> ```

## Scope

Every shipped surface: Shell, Toolbar, Sidebar, TitleBar, StatusBar, VirtualGrid /
ListRow / PhotoTile / SelectionPill, Lightbox, Inspector, Settings panes, all dialogs
(Import, Export, Offload, Key, Interop, Album, Purge), Toast, and the lock / protected
surfaces ([#305](https://github.com/qwts/photos/issues/305)).

Two methods, because neither is sufficient alone:

1. **Automated** — axe-core 4.13.0 against the `wcag2a`, `wcag2aa`, `wcag21a`,
   `wcag21aa`, `wcag22aa` tags, over every checked-in story and 5 composed E2E
   flows.
2. **Manual source + interaction audit** — the criteria axe cannot test. In practice axe
   detects roughly a third of WCAG issues; every finding in
   [Severity ranking](#severity-ranking) below that is not tied to an axe rule is
   invisible to it.

**Amended 2026-07-17** — the first pass shipped this page titled "WCAG 2.2 AA" while
four of the six criteria that are _new_ at A/AA in 2.2 had never been checked
(2.4.11, 2.5.7, 3.2.6, 3.3.7). They are now audited below in
[WCAG 2.2 completeness](#wcag-22-completeness), and the disability categories the scope
never stated are stated in [Coverage by category](#coverage-by-category). Net: one new
finding ([#449](https://github.com/qwts/photos/issues/449)), three passes, one N/A.

**Amended 2026-07-21** — #401 centralized reduced-motion behavior, added a
semantic token-pair contrast gate backed by shared WCAG luminance math, and
added composed Electron coverage at 200% zoom. #409 had already removed the 61
baseline contrast violations. Text over user photos remains explicitly manual.

**Revalidated 2026-08-23** — #1046 bumped axe-core from 4.12.1 to 4.13.0. The
hosted Storybook and composed E2E accessibility lanes both passed at exact head
`952f592e`; the empty per-rule violation budget remained empty. This rerun covers
the changed automated rule set. The dependency-only diff did not change rendered
surfaces, so the manual source and interaction findings below are unchanged.

## Historical baseline: 103 automated violations

|                                  | Violations | Surfaces          |
| -------------------------------- | ---------- | ----------------- |
| Story lane (isolated components) | **89**     | 64 of 107 stories |
| E2E lane (composed app)          | **14**     | 5 of 5 flows      |

### By rule

| Rule                    | Count     | Impact       | WCAG SC                | Owner                                                         |
| ----------------------- | --------- | ------------ | ---------------------- | ------------------------------------------------------------- |
| `color-contrast`        | 61        | serious      | 1.4.3                  | [#409](https://github.com/qwts/photos/issues/409)             |
| `target-size`           | 10        | serious      | **2.5.8** (new in 2.2) | [#415](https://github.com/qwts/photos/issues/415)             |
| `button-name`           | 9         | **critical** | 4.1.2                  | [#410](https://github.com/qwts/photos/issues/410)             |
| `aria-progressbar-name` | 4         | serious      | 4.1.2                  | [#410](https://github.com/qwts/photos/issues/410)             |
| `nested-interactive`    | 4         | serious      | 4.1.2                  | [#412](https://github.com/qwts/photos/issues/412)             |
| `aria-prohibited-attr`  | 0 (was 1) | serious      | 4.1.2                  | Resolved by [#400](https://github.com/qwts/photos/issues/400) |

### By component (story lane)

`App/SettingsDialog` 22 · `App/Sidebar` 14 · `Interop/Transfer and Sync` 10 ·
`App/ImportDialog` 5 · `Grid/ListRow` 5 · `Grid/SelectionPill` 4 · `App/Inspector` 4 ·
`App/KeyDialog` 3 · `App/LockScreen` 3 · `Feedback/Primitives` 3 ·
`App/ProtectedAlbumCeremony` 2 · `Grid/VirtualGrid` 2 · `App/ExportDialog` 2 ·
`App/ProtectedAlbumView` 2 · `Media/PhotoTile` 2 · plus 6 surfaces at 1 each.

**Read this distribution with care.** It counts axe rule-instances per story, so it
reflects how often a surface is _storied_, not how broken it is. 61 of the 89 story
violations come from **two colour tokens**. The honest summary is: _four root causes
produce 84 of the 103 violations._

## Severity ranking

Ranked by user impact, not by count.

### S1 — blocks a screen-reader user from completing a task

| #   | Finding                                                                                                                                                                                                                                                        | Owner                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | **The Lightbox is a modal that is not a dialog.** No `role="dialog"`, no `aria-modal`, no focus trap, no initial focus, no focus restore. The whole shell stays in the a11y tree and Tab order underneath it. `Dialog.tsx` already does all of this correctly. | [#399](https://github.com/qwts/photos/issues/399)                                                     |
| 2   | **Lightbox chrome auto-hides after 2.2s of mouse idle with no keyboard wake path.** `onMouseMove` is the only waker, so a keyboard-only user's controls vanish and never return (**2.2.1**, and **2.4.7** if focus lands on a faded control).                  | [#399](https://github.com/qwts/photos/issues/399)                                                     |
| 3   | **Partially resolved.** `VirtualGrid` now exposes a whole-library list with stable `aria-posinset`/`aria-setsize` and descriptive photo names. Roving focus and the path past the grid remain owned by [#399](https://github.com/qwts/photos/issues/399).      | [#399](https://github.com/qwts/photos/issues/399) · [#400](https://github.com/qwts/photos/issues/400) |
| 4   | **9 critical `button-name`**: every `Switch` in Settings is nameless — backup, privacy, and encryption toggles announce as "switch, checked" with no subject.                                                                                                  | [#410](https://github.com/qwts/photos/issues/410)                                                     |
| 5   | **Toasts auto-dismiss in 4s, taking their action button with them.** The app's primary async channel; the action is unreachable in the time available and unrecoverable after (**2.2.1**).                                                                     | [#411](https://github.com/qwts/photos/issues/411)                                                     |

### S2 — serious: information lost or wrong

| #                 | Finding                                                                                                                                                                                                                                                                                                                                                | Owner                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 6                 | **`--text-faint` never reaches 4.5:1 on any surface** (3.24–4.15 measured). It is the default colour of `.mono-data` — so the app's entire machine-readable layer (EXIF, counts, sync states) is sub-AA. 51 CSS usages.                                                                                                                                | [#409](https://github.com/qwts/photos/issues/409) |
| 7                 | **`--accent-red` on `--accent-red-dim`** — the resting `.ovl-button--danger`, 3.37–4.45 vs 4.5. The destructive control is the one that is hardest to read.                                                                                                                                                                                            | [#409](https://github.com/qwts/photos/issues/409) |
| 8                 | **Targets below 24×24** — "New album" is **13×13**; tile select 18×18; list-row select 16×16. None qualify for the spacing exception.                                                                                                                                                                                                                  | [#415](https://github.com/qwts/photos/issues/415) |
| 9                 | **`nested-interactive`** — tiles/rows are `role="button"` divs containing a real `<button>`; ARIA makes those children presentational, so the select control's name and pressed state may be discarded. They also handle **Enter but not Space**.                                                                                                      | [#412](https://github.com/qwts/photos/issues/412) |
| 10                | **`Dialog` never restores focus on close.** Closing drops focus to `<body>`. Every dialog inherits it; `Shell` and `Sidebar` hand-patch around it per-site, which is the tell. **One fix in the primitive deletes the workarounds.**                                                                                                                   | [#399](https://github.com/qwts/photos/issues/399) |
| 11                | **Nothing hides the background from AT when a modal is open.** The Tab trap holds, but virtual-cursor/browse-mode users can still read and activate the entire app behind the scrim. The counterpart to the trap that already exists.                                                                                                                  | [#399](https://github.com/qwts/photos/issues/399) |
| 12                | **Resolved.** One queued announcer now covers toasts, backup state, Inspector swaps, quarter-step Import/Export progress, selection and result counts, empty states, SD-card detection, library switches, and Lightbox photo/custody changes. Failures use the assertive channel; duplicate component-local toast announcements were removed.          | [#400](https://github.com/qwts/photos/issues/400) |
| <a id="28"></a>28 | **Resolved — zoomed lightbox pan was wheel-only (2.1.1, Level A).** Arrow keys now pan each overflowing axis through the same clamped geometry as wheel input. Left/Right continue stepping photos whenever horizontal panning is unavailable, preserving Fit and one-axis Fill navigation. Storybook and composed Electron coverage guard both modes. | [#449](https://github.com/qwts/photos/issues/449) |
| 13                | **Resolved.** The zoom controls are a toolbar, the transfer toggle is a labeled group, and password meters expose an image role with their strength name. The `aria-prohibited-attr` budget is now empty.                                                                                                                                              | [#400](https://github.com/qwts/photos/issues/400) |
| 14                | **SC 2.1.4 Character Key Shortcuts (Level A)** — `i`, `+`, `-`, `0` are unmodified single-key shortcuts on `window`: not remappable, not disableable, not focus-scoped. The `inField` guard checks only `input, textarea` — not `[contenteditable]`, `select`, or `role="textbox"`, and the two guards in the codebase disagree with each other.       | [#399](https://github.com/qwts/photos/issues/399) |

### S3 — moderate

| #   | Finding                                                                                                                                                                                                                                            | Owner                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 15  | **Resolved.** Photo tools are a named region containing a named toolbar, and the existing skip link targets the main content.                                                                                                                      | [#400](https://github.com/qwts/photos/issues/400)                                                     |
| 16  | **Resolved.** The current view is an `h1`; Sidebar groups and Inspector sections form an ordered heading outline; dialog titles are `h2`.                                                                                                          | [#400](https://github.com/qwts/photos/issues/400)                                                     |
| 17  | **Resolved.** Settings and export rows are labeled groups, and password-field accessible names now match their visible labels.                                                                                                                     | [#400](https://github.com/qwts/photos/issues/400)                                                     |
| 18  | **Resolved.** Active icon controls expose `aria-pressed`, password strength meters expose a named state, and the semantic contrast gate covers active/resting token pairs.                                                                         | [#400](https://github.com/qwts/photos/issues/400) · [#401](https://github.com/qwts/photos/issues/401) |
| 19  | **Resolved.** Tooltips are connected with `aria-describedby`, remain hoverable, and dismiss on Escape.                                                                                                                                             | [#400](https://github.com/qwts/photos/issues/400)                                                     |
| 20  | **Resolved.** Inspector metadata uses `<dl>`/`<dt>`/`<dd>`.                                                                                                                                                                                        | [#400](https://github.com/qwts/photos/issues/400)                                                     |
| 21  | **Resolved.** Settings uses the tablist/tab/tabpanel pattern with roving focus, arrow keys, Home/End, and `aria-controls`.                                                                                                                         | [#399](https://github.com/qwts/photos/issues/399) · [#400](https://github.com/qwts/photos/issues/400) |
| 22  | **`SelectionPill`'s `role="menu"` is not a menu** — no focus management, no arrow keys, no Escape, no restore; trigger lacks `aria-haspopup`/`aria-expanded`. Same for `PhotoContextMenu`'s missing restore.                                       | [#399](https://github.com/qwts/photos/issues/399)                                                     |
| 23  | **`anyDialogOpen` tracks 3 of ~11 dialogs.** With an Offload/Key/Interop/Protected dialog open, `i` toggles the inspector behind it and ⌘A selects the library underneath. `LightboxViewport` solves this generically; `use-global-keys` does not. | [#399](https://github.com/qwts/photos/issues/399)                                                     |
| 24  | **`⌘K` is advertised but not implemented** — `SearchField` renders the hint app-wide; no handler exists. A false affordance.                                                                                                                       | [#399](https://github.com/qwts/photos/issues/399)                                                     |
| 25  | **Resolved.** The renderer motion-token layer collapses transitions to 1 ms and repeating animations to one iteration, including syncing status and Lightbox chrome; Electron coverage guards the contract.                                        | [#401](https://github.com/qwts/photos/issues/401)                                                     |
| 26  | **Resolved.** The submit button keeps the stable name “Unlock”; the visual countdown is separate and hidden from AT.                                                                                                                               | [#400](https://github.com/qwts/photos/issues/400)                                                     |
| 27  | **Resolved.** Prose in `.mono-data` is natural-case source text; the existing CSS `text-transform: uppercase` preserves the visual system. Technical acronyms and filenames remain literal.                                                        | [#400](https://github.com/qwts/photos/issues/400)                                                     |

## WCAG 2.2 completeness

WCAG 2.2 adds six criteria at Level A/AA over 2.1. The first pass audited two of them and
did not say so. All six, with evidence:

| SC                                            | Level | Verdict             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **2.4.11 Focus Not Obscured (Minimum)**       | AA    | **Pass — measured** | axe has no rule for this one, so it is now gated by a probe in `tests/e2e/a11y.spec.ts`: focus every focusable control in the composed shell with the selection pill up, then test whether any is _entirely_ covered. **103 controls, 0 obscured.** The two floating surfaces (`.ovl-toast-host`, `.ovl-pill`) are thin bars over much larger tiles, and reveal-on-hover controls use `:focus-within`, so they are visible exactly when focus arrives. |
| **2.5.7 Dragging Movements**                  | AA    | **Pass**            | Three drag paths, each with a single-pointer alternative: tile/row → album drag is also `SelectionPill` → "Add to album" → `AlbumPicker`; the shell's OS file-drop is also Toolbar → Import; `KeyDialog`'s "Choose or drop a .key file" is also a click. Lightbox pan is **wheel**, not drag (`draggable={false}` on the image) — so 2.5.7 does not reach it, but [2.1.1 does](#28).                                                                   |
| **2.5.8 Target Size (Minimum)**               | AA    | Fail                | Finding 8 — [#415](https://github.com/qwts/photos/issues/415). Audited in the first pass.                                                                                                                                                                                                                                                                                                                                                              |
| **3.2.6 Consistent Help**                     | AA    | **Pass — vacuous**  | The SC only applies when a help mechanism repeats across pages. The app has **none**: no help link, no contact route, no docs affordance. `RestoreWorkflow`'s `ERROR_HELP` is inline error text on one surface, not a help mechanism. **Expiry: the moment a Help/Support/docs affordance is added to more than one surface, this becomes live** and it must sit in the same relative order everywhere.                                                |
| **3.3.7 Redundant Entry**                     | A     | **Pass**            | The only repeat-entry in the app is password confirmation (`ProtectedAlbumCeremony`, `AppPasswordDialog`), which is the SC's own security/essential exception. No multi-step flow re-asks for data it already holds; the ceremonies clear their fields **only on success** (after `onComplete`) and retain them on error, which is the correct behaviour — clearing on failure would create the violation.                                             |
| **3.3.8 Accessible Authentication (Minimum)** | AA    | Pass                | `PasswordField` blocks copy/cut but **not paste**, so password managers work. Verified in the first pass; recorded under [Accepted exceptions](#accepted-exceptions) because it reads like a failure.                                                                                                                                                                                                                                                  |

## Coverage by category

The first pass organised by criterion and by axe rule, which hid an obvious question:
which disabilities are actually covered? Stated plainly, because "WCAG 2.2 AA" is a
standard, not a synonym for "accessible":

| Category                                    | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Visual**                                  | **Strongest.** #409 removed the 61 baseline contrast violations; #401 now gates declared semantic pairs, centralizes reduced motion, and exercises the composed app at 200% Electron zoom. Gap automation cannot close: **text over photos** (Lightbox chrome, tile overlays) sits on user content of unknown luminance and stays in the [manual visual pass](./acceptance/Acceptance-Test-Visual-Accessibility.md).                                                                                                                                                                                                                                        |
| **Screen reader / comprehension of the UI** | Well covered — most of the 27 manual findings are semantics, owned by [#400](https://github.com/qwts/photos/issues/400). The [VoiceOver script](./acceptance/Manual-Test-A11y-VoiceOver.md) is the only thing that judges whether a flow is _completable_; NVDA parity is an explicit follow-up, not silently skipped.                                                                                                                                                                                                                                                                                                                                      |
| **Motor**                                   | **Partial, by scope decision.** Keyboard operation ([#399](https://github.com/qwts/photos/issues/399)), target size ([#415](https://github.com/qwts/photos/issues/415)), dragging alternatives (2.5.7, above) are in. **Switch control and voice control are explicitly out of scope** in [#381](https://github.com/qwts/photos/issues/381) as "beyond what AA requires" — that is a scope line, not coverage, and AA does not imply either works.                                                                                                                                                                                                          |
| **Hearing**                                 | **N/A — verified, with an expiry.** There is no `<video>`, no `<audio>`, and no time-based media anywhere in the renderer, so 1.2.x has nothing to apply to. **This is a fact about today, not a property of the app**: a photo library acquires video import sooner or later, and on that day captions (1.2.2) and audio description (1.2.5) go from N/A to unaudited. **The expiry is enforced, not remembered** — `jsx-a11y/media-has-caption` is on and errors the build the first time a `<video>`/`<audio>` element lands without a `<track>`.                                                                                                        |
| **Cognitive**                               | **Thinnest — and AA is thin here too.** What is covered is timing: toasts auto-dismissing in 4s ([#411](https://github.com/qwts/photos/issues/411)), lightbox chrome auto-hiding (finding 2), the lock throttle (accepted). All were found via 2.2.1 as _keyboard_ issues; none were found by asking a cognitive question. 3.2.6 and 3.3.7 (the two 2.2 criteria closest to this category) now pass, both vacuously. Honest read: the app is not hostile here, and nobody has actually evaluated it here. Level AAA is where this category lives (3.1.5 reading level, 2.2.6 timeouts, 3.3.9 accessible authentication (no exception)) and is not a target. |

## Accepted exceptions

| Finding                                                                          | Rationale                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LockScreen throttle is a timed restriction with no adjustment** (2.2.1)        | Accepted under 2.2.1's **Essential** exception: the delay _is_ the brute-force control, and making it adjustable would defeat it. The countdown must still be announced non-continuously — that part is finding 26, not an exception. |
| **`Switch checked disabled` for "Encrypt originals (always on)"** (ImportDialog) | Accepted. The label states the reason, and encryption is an invariant, not a preference (ADR-0004). `aria-disabled` + an explanation would be marginally better and is not worth a blocking issue.                                    |
| **`alt` text is the filename, not a description** (1.1.1)                        | Accepted for now. No descriptions exist in the data model, and a filename is more useful than an empty string for a photo manager. Revisit if/when captions land.                                                                     |
| **Zoom controls hidden with `visibility: hidden` in list mode**                  | Not a finding. `visibility: hidden` correctly removes them from both the a11y tree and the Tab order. Recorded so it is not re-reported.                                                                                              |
| **`Dialog`'s Escape starves `use-global-keys`**                                  | Not a finding. `Dialog` listens on `document` and calls `stopPropagation`; `use-global-keys` listens on `window`, so the document listener wins. Verified. Recorded so the two mechanisms are not "fixed" into conflict.              |
| **`PasswordField` blocks copy/cut** (3.3.8 Accessible Authentication)            | **Not a finding — verified.** `onCopy`/`onCut` are prevented but **`onPaste` is not**, so password managers and paste-based entry work. 3.3.8 passes. Recorded because it looks like a failure on a quick read.                       |
| **`region` / `page-has-heading-one`**                                            | Out of automated scope by design: both are axe **best-practice** rules, not WCAG AA, and the budget pins the AA tag set. The underlying gaps are still tracked as findings 15 and 16 against 1.3.1/2.4.1.                             |

## What the automation cannot see

Recorded so the gate is not mistaken for proof of accessibility.

- **The story lane mounts components in isolation.** Landmark uniqueness, focus order
  across regions, an overlay leaving the shell in the a11y tree, and live regions
  colliding do not exist until the app composes them — hence the E2E lane.
- **Neither lane can judge whether a flow is _completable_.** Announcement order, whether
  a live region fires at a useful moment, and whether the grid is navigable in practice
  are what the [VoiceOver script](./acceptance/Manual-Test-A11y-VoiceOver.md) is for.
- **axe's contrast check cannot see text over photos** — the Lightbox chrome and tile
  overlays sit on user content of unknown luminance. This stays in the
  [manual visual-accessibility pass](./acceptance/Acceptance-Test-Visual-Accessibility.md).
- **`target-size` and other 2.2-era rules only run because the tag set asks for them.**
  They are not in axe's defaults.
- **Neither axe lane sees pointer-only handlers.** A `div` with `onClick` and no key
  handler renders identically to an accessible one; axe audits the DOM, not the intent.
  This is what the `jsx-a11y` lint lane (strict, on `src/renderer`) is for — it reads the
  source. It is why finding 28 exists.
- **What the amendment changed:** 2.4.11 was in this list — "axe has no rule, so nobody
  is checking" — and is now measured by the focus-obscured probe. The remaining entries
  above are still true.

## Strengths worth preserving

Frame remediation as "apply the pattern already here", not "invent one":

- **`Dialog.tsx`** — focus trap with a disabled-aware selector, a `dialogStack` so only the
  topmost modal owns Escape/Tab, and `onClose` read through a ref. Missing only restore.
- **`Segmented.tsx`** — `role="radiogroup"` + roving `tabIndex` + arrow keys that skip
  disabled options. The reference for findings 21 and 13.
- **`IconButton.tsx`** — `label` required and `Omit<…, 'aria-label'>` makes it
  un-bypassable. The model for [#410](https://github.com/qwts/photos/issues/410).
- **`Icon.tsx`** — `aria-hidden` on every glyph by construction.
- **`LockScreen.tsx`** — `<form>` + `<h1>` + an always-present, initially-empty
  `role="status"`. The correct live-region technique; `Toast.tsx` should copy it.
- **`Sidebar.tsx`** — Shift+F10 / ContextMenu key, and focus restore that falls back when
  the opener row is destroyed.
- **`AlbumActionMenu.tsx`** — added by the amendment; the first pass missed it. A
  **complete** APG menu: initial focus on the first menuitem, Escape, outside-pointerdown
  close, and ArrowUp/ArrowDown/Home/End roving. This is the reference for finding 22
  (`SelectionPill`'s `role="menu"` that is not a menu) — the correct implementation was
  already in the repo, two directories away from the broken one. Its `:focus-within`
  reveal of `.ovl-sidebar__album-actions` is also why 2.4.11 passes.
- **`OffloadDialog`** (`<ul>`), **`InteropWorkflowDialog`** (`<dl>`, `<fieldset>`/
  `<legend>`, `htmlFor`) — the only correct instances of each; generalise them.

## Keyboard infrastructure review (seeds #399)

`src/renderer/src/state/use-global-keys.ts` is 41 lines: one `window` `keydown` listener,
a flat if-chain, no registry.

| Key        | Action                                     | Guards                          |
| ---------- | ------------------------------------------ | ------------------------------- |
| `⌘/Ctrl+A` | select all photos in the active collection | not in field, no tracked dialog |
| `Escape`   | exit lightbox, else clear selection        | no tracked dialog               |
| `i`        | toggle inspector                           | not in field, no tracked dialog |
| `←` / `→`  | step lightbox ±1, wrapping                 | lightbox open                   |

`+`/`-`/`0` (zoom) are registered **separately** in `LightboxViewport.tsx` with a
_different, inconsistent_ guard.

Limitations for #399 to absorb: no registry or discoverability surface (no shortcuts
help; ⌘A and the zoom keys are documented nowhere in the UI); 2.1.4 failure (finding 14);
`anyDialogOpen` tracks 3 of ~11 dialogs (finding 23); no arrow navigation, Home/End,
Space-to-select, or range selection in the grid; no focus awareness; not remappable; the
listener re-subscribes on every `state.photos` change. **⌘A now resolves the complete
active collection, including unloaded virtualized rows** (#884).

## Method

- axe-core 4.13.0, pinned exact and overridden into `axe-playwright`'s floating
  `^4.10.1`: its rule set _defines_ every count here, so it must not drift silently.
  A bump is expected to move numbers — re-audit in that PR.
- The budget records counts **per axe rule**, so the tables above are not just totals:
  a surface cannot swap one rule for another and stay within budget.
- Story lane scopes to `#storybook-root`, so Storybook's own chrome never enters the budget.
- E2E flows: `shell-grid`, `shell-lightbox`, `shell-inspector`, `shell-settings-dialog`,
  `shell-selection`, on the deterministic seeded profile.
- Manual pass: source audit of all renderer surfaces against the 2.2 AA criteria axe does
  not implement, plus verification of each "needs checking" item against the CSS.
  **The first pass claimed this was complete and it was not** — it was organised around
  the surfaces and the axe rule set, so criteria with no axe rule and no obvious surface
  (2.4.11, 2.5.7, 3.2.6, 3.3.7) fell through. The 2026-07-17 amendment walks the
  criterion list itself, which is why [WCAG 2.2 completeness](#wcag-22-completeness) is a
  table of all six rather than prose. Re-audit the same way: **enumerate the criteria,
  then go looking** — auditing what the tools point at reproduces exactly this gap.
- Where a criterion is now gated rather than reasoned about, the gate is named in the
  evidence column. Three of the four amended criteria are gated by construction:
  2.4.11 by the focus-obscured probe, hearing/1.2.x by `jsx-a11y/media-has-caption`,
  and pointer-only handlers (2.1.1, how finding 28 surfaces) by `jsx-a11y`'s strict rules.
