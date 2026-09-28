# Manual Test — VoiceOver (macOS)

> The screen-reader half of the accessibility gate. Automated axe checks
> ([Testing Strategy](../Testing-Strategy.md)) prove the a11y _tree_ is well-formed; they cannot
> prove a blind user can finish a task. This script does.
>
> Established by [#398](https://github.com/qwts/photos/issues/398) for epic
> [#381](https://github.com/qwts/photos/issues/381); reused by
> [#400](https://github.com/qwts/photos/issues/400) (screen-reader semantics). Windows /
> NVDA parity is an explicit follow-up, not a silent omission.
>
> **Run it when:** a child of #381 lands a semantics change; before closing #381; and on
> any PR that touches landmarks, live regions, focus management, or dialog structure.

## Why this exists as a script and not a checklist

Most of the highest-severity findings in the
[July 2026 audit](../Accessibility-Audit-2026-07.md) — the Lightbox not being a dialog, toasts
taking their action away after 4s, the grid announcing "3 of 40" for a 40,000-photo
library — are **invisible to axe**. They are only findable by driving the app the way a
screen-reader user does. A checklist of attributes would have passed all three.

## Setup

1. Build and launch the seeded profile — a deterministic library, so counts are known:

   ```sh
   npm run seed:dev
   ```

2. Turn VoiceOver on: **⌘F5** (or Touch ID triple-press). **⌃⌥** is "VO" below.
3. **VO+U** opens the rotor; **⌃⌥←/→** move by element; **VO+Space** activates.
4. Open the Web Item rotor with **VO+U** and check **Landmarks** and **Headings** — the
   first two tests read those lists directly.
5. Turn the **screen off**, or look away, for tests 3–7. If you can see the app you will
   unconsciously compensate and the test is worthless.

Record results as **pass / fail / partial** with the announcement **verbatim** — the exact
string is the evidence, and paraphrase loses the defect.

## Tests

### 1. Landmarks — can you orient?

**VO+U → Landmarks.**

- **Expect:** a landmark for each region — banner (title bar), navigation ("Library"),
  the toolbar, main, complementary ("Inspector") when open, contentinfo (status bar).
- Confirm the “Photo tools” region contains search, Filters, View, Zoom, and Import, and
  the skip link moves focus to the named main view. The row is not announced as a
  toolbar: it has no arrow-key navigation, so each control is its own Tab stop (#1290).

### 2. Headings — is there an outline?

**VO+U → Headings.**

- **Expect:** an `h1` naming the view, and headings for Sidebar groups
  (Library / Albums / Protected) and Inspector sections.
- Open Settings and confirm its dialog title precedes the pane's `h3` in the outline.

### 3. Browse the grid — is the count true?

Tab into the grid, then **⌃⌥→** through tiles.

- **Expect:** each photo announces its position in the **whole library** ("3 of 1,204").
- Confirm each name includes filename, localized date, and place when available.
- Also check: is there any way **past** the grid without tabbing every tile? (No.)
- On a tile, press **Space**. **Known fail** (finding 9,
  [#412](https://github.com/qwts/photos/issues/412)): only Enter works.
- Listen for the select circle's name and pressed state. **Known fail:** it is nested
  inside `role="button"`, so it may be discarded entirely.

### 4. Select photos — is the selection announced?

**⌘A**, then select and deselect individual photos.

- **Expect:** the selection count is announced as it changes.
- Reach the pill's overflow menu by keyboard. Focus should enter the first item; arrow
  keys and Home/End move within it; Escape closes it and restores focus to the trigger.
- Note: ⌘A selects only the **loaded page**, not the library. Compare what was announced
  against the status bar's total.

### 5. Open the Lightbox — the modal test

Enter on a tile.

- **Expect:** focus moves into the overlay; it is announced as a dialog; the shell behind
  it is unreachable; Escape returns focus **to the tile you came from**.
- **Known fail** (findings 1, 2, [#399](https://github.com/qwts/photos/issues/399)):
  it is **not a dialog** — no trap, no `aria-modal`, no restore. Navigate with the
  **virtual cursor (VO+→)** past the overlay: you will read the entire shell underneath.
  This is the test that catches it; Tab alone does not.
- Wait **3 seconds without touching the mouse**, then try to reach the controls by
  keyboard. **Known fail:** chrome hides on mouse-idle with no keyboard wake path.
- Step with ←/→ — is the new photo announced at all?
- On an offloaded photo, watch the custody strip (`FETCHING ORIGINAL…` →
  `STREAMING ORIGINAL…`). Each photo and custody transition should be announced once;
  an unavailable original should interrupt through the assertive channel.

### 6. Import — is progress audible?

Open Import, choose a folder, run it.

- **Expect:** phase changes and completion are announced; failures are announced
  assertively.
- Progress is intentionally throttled to quarter steps. Insert an SD card mid-dialog and
  confirm the `Looking for cards…` → detected transition is announced once.
- Find the "Generate thumbnails on import" checkbox: it is `checked` with no `onChange`
  and is not disabled — it cannot be changed and does not say so.

### 7. Toasts — can you reach the action?

Trigger an operation that toasts with an action (an import completion, or a failed backup
with "Retry").

- **Expect:** the toast is announced; the action is reachable and activatable.
- **Known fail** (finding 5, [#411](https://github.com/qwts/photos/issues/411)): it
  auto-dismisses after **4 seconds**, taking the action with it. Time it: from the end of
  the announcement, can you tab to the button before it vanishes? Record how long the
  announcement itself takes — that is the argument.
- Also: the toast mounts _with_ `role="status"` rather than living as a persistent region,
  so the announcement may not fire at all. Try several times; intermittency is the symptom.

### 8. Dialogs — does focus come back?

Open Settings, tab around, close with Escape.

- **Expect:** focus returns to the gear button.
- **Known fail** (finding 10, [#399](https://github.com/qwts/photos/issues/399)): focus
  drops to `<body>` — you are dumped at the top of the document. Repeat for Export,
  Offload, and Key.
- Open the library switcher and **Tab** along a row (#1299). **Expect:** the row reads as
  its library, then "Actions for {name}, menu pop-up button"; nothing else. Open the ⋯,
  choose Rename folder…, and press Escape: focus is back on that ⋯. A disabled item reads
  its reason ("Move…, dimmed, Reconnect the volume first."). Choose **Move several…**:
  "Choose libraries to move. Press Space to select, Escape to cancel." is announced, rows
  read as checkboxes, Space checks one and the count is read ("1 selected."), and Escape
  announces "Move canceled. Nothing was moved." with focus back on Move several….
- With Settings open, use the **virtual cursor** to read behind the scrim.
  **Known fail** (finding 11): nothing is `inert`/`aria-hidden`.
- Navigate the Settings section nav with **arrow keys**. **Known fail** (finding 21): it
  is a tab pattern with no tab semantics.
- Tab through a Settings pane (#1295). **Expect:** each switch, segmented control,
  select, and slider is read by its row's label, then its hint, with no "group" and
  no label read twice. A lone button keeps its own name and reads the row's label and
  hint after it ("Lock now, Lock now, Immediately seals the library…"). A row of
  several buttons is a group named by the row, so each "Remove…" is told apart ("App
  password, group, Remove…"). Custom themes, Quick Actions, Semantic search, Offloaded
  originals, Finder access, and Share diagnostics are read as groups named by their
  label.

### 9. Lock and protected surfaces — accessible _and_ fail-closed

Lock the app (⌘L or Settings → Privacy).

- **Expect:** `h1` announced, password field named, errors announced politely.
  This surface is the **best** in the app — it should largely pass.
- Enter a wrong password 5× to trigger the throttle. **Known fail** (finding 26): the
  countdown re-announces the focused button ~4×/sec. The throttle **itself** is an
  [accepted exception](../Accessibility-Audit-2026-07.md#accepted-exceptions) (2.2.1 Essential).
- Open a protected album, then relock. **Known fail:** focus lands on `<body>` with no
  announcement that the view was torn down.
- **Critically:** confirm nothing about protected content leaks into the a11y tree while
  locked. Fail-closed **and** accessible ([#305](https://github.com/qwts/photos/issues/305)).
  A leak here is a security bug, not an a11y bug — escalate it as one.

### 10. Shortcut conflicts

With VoiceOver on, open a dialog **not** in `use-global-keys`' list (Offload, Key, or
Interop) and press **`i`**.

- **Known fail** (finding 23, [#399](https://github.com/qwts/photos/issues/399)): the
  inspector toggles _behind_ the dialog. `anyDialogOpen` tracks 3 of ~11 dialogs.
- Type `i` into any password field and confirm the inspector does **not** toggle (the
  `inField` guard covers `input`, so this should pass).
- Note for 2.1.4 (finding 14): `i`, `+`, `-`, `0` are unmodified single-key shortcuts and
  are not remappable or disableable — a **Level A** failure regardless of this test's
  outcome.

## Reporting

- File each **new** finding as its own issue, severity-ranked, linked to
  [#381](https://github.com/qwts/photos/issues/381), and add it to the
  [audit report](../Accessibility-Audit-2026-07.md).
- For a **known** finding, confirming it still reproduces is the useful output — note it
  on the owning issue with the verbatim announcement.
- If a known fail now **passes**, say so on the issue: that is a fix landing, and the
  corresponding `tests/a11y/violation-budget.json` entry should be shrinking too.
- Record the run (date, macOS + VoiceOver version, commit SHA) on the issue that prompted
  it. VoiceOver behaviour changes across macOS releases; an undated pass is not evidence.
