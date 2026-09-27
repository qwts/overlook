# ADR-0020: Internationalization Architecture — Catalog, Extraction, Locale Model, RTL

## Status

Accepted 2026-07-17 on issue [#402](https://github.com/qwts/photos/issues/402) (proposed and owner-accepted the same day; any section may still be amended by owner veto before its implementing code lands). This ADR extends [ADR-0001](./ADR-0001-Automation-Check-Governance.md) (the ratchet in §6 is governed by it) and works within [ADR-0003](./ADR-0003-Desktop-Stack.md) (process layering); it rewrites nothing.

Amended 2026-09-26 on issue [#1287](https://github.com/qwts/overlook/issues/1287): §3's `.mono-data` scope narrows to machine values (see the amendment at the end).

Section map for the epic's children: §1, §2, §6 govern [#403](https://github.com/qwts/photos/issues/403) (catalog runtime, extraction, pseudo-locale gate); §3, §4 govern [#404](https://github.com/qwts/photos/issues/404) (locale-aware formatting); §2, §3, §5 govern [#405](https://github.com/qwts/photos/issues/405) (language setting, live switching, RTL). §7 governs the epic's translation workflow.

## Context

The app has **no internationalization of any kind today**: zero `Intl.` calls, zero locale detection, `<html lang="en">` hardcoded, zero `dir`, zero CSS logical properties. Everything below is measured, not estimated.

- **The renderer is the entire surface.** ~450–500 extraction sites (~200–270 JSX text nodes, 198 string-literal props). Worst files: `RestoreWorkflow.tsx`, `KeyDialog.tsx`, `ImportDialog.tsx`, `StoragePane.tsx`.
- **The main process is not a catalog consumer.** No application menu, no tray, no notifications. Four `dialog.show*` calls, all file pickers whose chrome the OS localises, carrying exactly **one** translatable string (`'Overlook recovery key'`, `crypto/recovery-key-picker.ts:7`). Its real user-facing surface is error text: 84 `Error` throws, a subset of which cross IPC and render verbatim (`RestoreWorkflow.tsx:330`, `InteropWorkflowDialog.tsx:120`, `OffloadedStorage.tsx:65`).
- **`src/shared/` purity does not bar a third-party runtime, and precedent settles it.** The `no-restricted-imports` matrix bans sibling _process_ directories only; "process-free" means no Electron/Node/DOM coupling, not no packages. `src/shared/` already carries **12 zod imports across 12 of its 26 files**, and `ipc/channels.ts` is a zod-backed runtime imported by both processes. Note zod is a **devDependency** that electron-vite bundles — `dependencies` holds only the three native modules.
- **`src/shared/library/format.ts` is worse than en-US-locked.** `formatCount` hardcodes `'en-US'`; `formatRelativeTime` returns pre-uppercased English (`'JUST NOW'`, `'5M AGO'`) that cannot pluralize; `formatBytes` hardcodes an SI ladder that is **unit-wrong in French** (`Go`, not `GB`). 22 renderer files, 117 sites. Meanwhile `RestoreWorkflow.tsx:86` calls bare `toLocaleString()` — so the app is _already_ inconsistent, adaptive in one place and en-US-pinned everywhere else.
- **Casing is applied three ways.** CSS `text-transform: uppercase` (8 rules, `.mono-data` used 83× across 27 files), ~50–60 literal-uppercase strings, and **16 runtime `.toUpperCase()` calls**. `Lightbox.tsx:173` double-applies CSS _and_ a literal.
- **RTL is a smaller job than it looks.** ~45–50 physical-direction CSS declarations, but many are direction-neutral `left:0;right:0` stretch pairs — the genuine migration is **~25–30 declarations**, concentrated in `lightbox.css` (13) and `shell.css` (11), where `left: calc(50% + 82px)` and `right: var(--inspector-w)` encode the inspector dock geometry.

Two measured facts drove decisions that intuition would have got wrong:

- **Digit shaping is regional, not "RTL".** `ar` → Latin digits; `ar-EG`/`ar-SA` → Arabic-Indic (`١٬٢٠٤`); `ar-MA` → Latin. CLDR already knows.
- **`fa-IR` defaults to the Persian calendar** — `۲۶ تیر ۱۴۰۵`, not July 2026. For an app whose organising principle is capture date, that is a live correctness hazard.

## Decision

### 1. Catalog runtime — FormatJS: `react-intl` in the renderer, `@formatjs/intl` held in reserve

We will use **FormatJS**. `react-intl` provides the renderer's provider, hooks, and components; ICU MessageFormat is the message syntax; `@formatjs/cli` does extraction and compilation.

The main process does **not** get it: it has one string (§2), so the runtime serves the renderer only.

Why, given the main process turned out not to be the deciding constraint:

- **One formatting model, not two.** #404's job is to retire `format.ts` in favour of `Intl`. FormatJS _is_ the ICU/`Intl` reference implementation: a single `IntlShape` yields `formatMessage`, `formatDate`, `formatNumber`, `formatList`, and `formatRelativeTime`. i18next ships its own interpolation and relegates ICU to the `i18next-icu` plugin — that is a second formatting system sitting next to `Intl`, i.e. exactly the drift we are retiring `format.ts` to end.
- **It composes with the pinned toolchain.** `react-intl@10` peers `react >=18.0.0` — it works against the held React 18.3.1 with **no new Dependabot ignore**. Lingui is otherwise attractive (tiny runtime, excellent extraction) but peers `babel-plugin-macros: 2 || 3`, coupling message extraction to the Babel pipeline under a Vite that is itself pinned pending electron-vite support. We decline to add a build-tool coupling to a toolchain that already carries four version caps.
- **No polyfills.** Node 24 and Electron 42's Chromium both ship full ICU and the complete `Intl` surface (`NumberFormat`, `DateTimeFormat`, `RelativeTimeFormat`, `PluralRules`, `ListFormat`, `Locale`, `Segmenter`, `DisplayNames` — all verified present). FormatJS's polyfill packages — a large dependency surface — are not installed.
- **The option on main stays free.** `@formatjs/intl` has **no peer dependencies** and is isomorphic. If an application menu or tray ever lands, main consumes the same catalogs via `createIntl` with no migration.

**Pins and placement.** Pure-JS, therefore **devDependencies**, bundled by electron-vite — following the zod/react precedent. Exact pins as ever; `@formatjs/cli` and `eslint-plugin-formatjs` are tooling-only.

**Message ids are explicit and namespaced** (`lightbox.close`, `import.done.summary`) — not content hashes. Explicit ids are greppable, survive copy edits without churning every catalog, and read well in the generated type union. The cost is manual discipline; `@formatjs/cli` enforces uniqueness at extraction.

**Ids are typed.** The `en` catalog is the source of truth; a generated union feeds FormatJS's `FormatjsIntl` interface augmentation so an unknown id is a compile error, not a runtime `[missing]`.

**Catalogs are precompiled to AST** (`formatjs compile`) at build. This removes runtime message parsing, shrinks the bundle, and keeps the renderer's strict CSP (`script-src 'self'`) untouched — nothing is ever `eval`'d or `Function`-constructed.

### 2. Locale model — one active locale, resolved in main, pushed to the renderer

**File layout.**

```
src/shared/i18n/locales.ts        # pure: supported set, RTL set, fallback negotiation. No deps.
src/shared/i18n/messages/en.json  # source catalog (extracted; the ratchet's mirror)
src/shared/i18n/messages/<lc>.json
src/renderer/src/i18n/            # react-intl provider + hooks (renderer-only)
```

We resolve the shared-versus-renderer tension explicitly: **`src/shared/` holds the locale _model_ and the catalog _data_; the React runtime stays in the renderer.** The model is pure logic that main legitimately needs (it resolves the OS default and persists the setting), and the data is inert JSON. Putting `react-intl` in shared would import a React binding into a process-free module for no current consumer.

**Resolution order:** explicit `language` setting → OS locale (`app.getLocale()`, resolved in main after `ready`) → `en`.

**Fallback chain:** requested tag → base language (`pt-BR` → `pt`) → `en`. A missing message falls back through the chain and never renders an id or an empty string.

**Setting:** `language: string | null` in the existing settings schema (`null` = follow the OS). It travels to the renderer over the existing typed IPC registry — a settings field and its existing change event, **no new IPC pattern**.

**Errors do not cross the boundary as prose.** Cross-process errors are identified by a stable machine-readable `code`; the renderer maps code → catalog copy. Raw `Error.message` becomes developer diagnostics — logged, never rendered. This honours #382's "no untranslated user-facing text" intent without a main-side catalog, and it retires the three verbatim render sites (`RestoreWorkflow.tsx:330`, `InteropWorkflowDialog.tsx:120`, `OffloadedStorage.tsx:65`). It also fixes a defect the #398 accessibility audit filed independently: `InteropWorkflowDialog.tsx:120` currently renders `error.code.replaceAll('-', ' ')` as user-facing copy.

The two contracts are **not** in the same state, and the difference is the work:

- `interopErrorSchema` (`shared/interop/messages.ts:29`) already carries `code: interopErrorCodeSchema` — a **zod enum** (`offline`, `auth-expired`, `quota`, …). Interop needs only to stop rendering `message` and map the existing enum to catalog ids.
- `restoreErrorSchema` (`shared/backup/restore-contract.ts:17`) carries **`message` only — there is no code**. It must gain an enumerated `code`, and its ~6 construction sites in main must be classified. That is real work, owned by #403, and it is the price of this ruling rather than a free consequence of it.

**A locale override for deterministic tests.** `OVERLOOK_LOCALE` joins the existing harness hooks (unpackaged-only, like every other `OVERLOOK_*`). The E2E and story lanes pin `en-US` so assertions on visible text stay deterministic; the pseudo-locale lane (§6) sets it explicitly. Without this, every text assertion in the suite becomes host-locale dependent — including `tests/perf/perf-harness.spec.ts:78,90`, which today assert `toLocaleString('en-US')` output and would otherwise block `format.ts`'s retirement.

### 3. Machine-data casing — CSS only, and all three mechanisms named

**Catalog strings are natural case. Casing is presentation, applied by CSS alone.** `.mono-data` keeps `text-transform: uppercase`. Concretely, all three mechanisms move:

1. **CSS `text-transform` (8 rules)** — kept, unchanged. This is the only mechanism that survives.
2. **~50–60 literal-uppercase strings** — rewritten to natural case in the catalog (`'LOCAL ONLY — NOT BACKED UP'` → `Local only — not backed up`). Rendering is unchanged for English because the CSS already uppercases them; `Lightbox.tsx:173`, which double-applies both, simply stops being redundant.
3. **16 runtime `.toUpperCase()` calls** — **deleted**, not localised. Locale-less `.toUpperCase()` is actively wrong (Turkish `i` → `I` instead of `İ`), and it defeats the entire ruling by baking casing into the string a screen reader receives.

`formatRelativeTime`'s pre-uppercased returns die with the function (§4).

**This ruling has a hard precondition: `lang` must be correct on `<html>`.** CSS `text-transform: uppercase` is language-sensitive — Turkish dotted/dotless i, German ß → SS, Greek accent stripping all key off the `lang` attribute. `lang` and `dir` are therefore set together at boot and on every language change (§5); the casing ruling and `dir`/`lang` propagation are one decision, not two.

**For scripts without case** (CJK, Arabic, Hebrew, Devanagari) `text-transform: uppercase` is a no-op. That is the correct outcome and needs no special case — which is precisely the argument for CSS over literals: a hardcoded uppercase English string has no such escape hatch.

**Why this matters beyond i18n:** literal-uppercase text is announced letter-by-letter by some assistive technology; CSS-transformed text is announced natural-case. #381's audit filed this independently (finding 27). One ruling settles both.

**Not everything in `.mono-data` is a message.** Identifiers and protocol values — `AES-256-GCM`, key fingerprints, file names, hashes — are not catalog strings and are not formatted, cased, or translated. The line is: _if it is language, it goes in the catalog; if it is an identifier, it is left alone._

### 4. Formatting — one locale, CLDR defaults, presentation-only output

**One active locale drives both messages and `Intl` in v1.** A separate region-format locale (es UI with US dates) is a real need for a real minority; it doubles the settings surface and the test matrix, and it is not on the epic's path. **Deferred, with the seam:** all `Intl` construction goes through one `src/shared/i18n/formats.ts` module, so adding a second resolved locale later is a change in one file, not 117. Owner: #404, revisit when a user asks.

**Follow CLDR defaults for numbering system and calendar. Do not override.** Measured: `ar` → Latin digits, `ar-EG`/`ar-SA` → Arabic-Indic, `ar-MA` → Latin; `fa-IR` → Persian calendar. CLDR encodes what each locale's readers actually expect. Forcing `-u-nu-latn` would be paternalistic and wrong for Cairo; forcing Arabic-Indic wrong for Casablanca. There is no "digit shaping policy for RTL" because digit shaping is not an RTL property.

**Formatted output is presentation-only.** It is never parsed back, never used as a map key, never sorted on, and never a test oracle. `fa-IR` rendering `۲۶ تیر ۱۴۰۵` is _correct_; code that round-trips that string is not. `takenAt` remains a floating Gregorian ISO wall-clock in the database (per #85) and all grouping and sorting key off stored values.

**`format.ts` is retired into `Intl`** (#404):

| Today                                       | Becomes                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `formatCount` — `toLocaleString('en-US')`   | `Intl.NumberFormat(locale)`                                                            |
| `formatRelativeTime` — `'5M AGO'`           | `Intl.RelativeTimeFormat(locale, { style: 'narrow', numeric: 'auto' })`                |
| `formatBytes` — `['B','KB','MB','GB','TB']` | `Intl.NumberFormat(locale, { style: 'unit', unit: 'gigabyte', unitDisplay: 'short' })` |

`Intl` supports `byte` through `petabyte` natively at base-1000, which matches the existing ÷1000 ladder exactly — so the unit _selection_ logic survives and only the rendering changes. This is not cosmetic: French renders `Go`, not `GB`.

**The terse mono aesthetic does not survive translation, and that is accepted.** `Intl.RelativeTimeFormat` narrow gives `5m ago` (en) and `5分前` (ja) but `vor 5 m` (de) and `قبل ٥ دقائق` (ar-EG). The design's fixed-width mono chrome must absorb variable-length strings; the pseudo-locale (§6) is what surfaces the overflow before a user does.

**Hidden scope worth naming:** dates are currently formatted by _string slicing_ (`importedAt.slice(0, 10)` in `Inspector.tsx:57,101`), which is locale-proof but locale-deaf and invisible to any `Intl`/`toLocale` grep. #404 must sweep for it.

### 5. RTL — logical properties, `dir`/`lang` at the root, a narrow icon allowlist

**CSS migrates to logical properties** — `inline-start`/`inline-end`, `margin-inline-*`, `padding-inline-*`, `text-align: start/end`, `border-inline-*`. The genuine surface is ~25–30 declarations (the `left:0;right:0` stretch pairs are direction-neutral and stay). `lightbox.css` and `shell.css` carry the hard cases, where the inspector dock geometry is encoded as `left: calc(50% + 82px)` and `right: var(--inspector-w)`.

**`dir` and `lang` are stamped together** on `document.documentElement` at boot and on every language change, driven by the RTL set in `src/shared/i18n/locales.ts` (`ar`, `he`, `fa`, `ur` and their regional tags). `dir` drives layout; `lang` drives casing (§3) and hyphenation. Neither is optional.

**Icons: an explicit mirror allowlist, default off.** `Icon.tsx`'s 54-name vocabulary is already exhaustively typed, which makes it the right place. Mirrored: `arrow-left`, `chevron-left`, `chevron-right`, `panel-left-close`, `panel-left-open`. **Never mirrored, and this is the point of an allowlist over a blanket flip:** `rotate-ccw` / `rotate-cw` (mirroring inverts the physical meaning of a rotation control) and `flip-horizontal-2` (whose meaning _is_ the horizontal axis). `share` and `sliders-horizontal` are judgement calls left to #405 with a bias to leaving them alone.

Photographs are never mirrored.

**Directional keys follow visual direction.** In RTL the sequence is laid out right-to-left, so `ArrowRight` moves visually right, which is _backwards_ through the sequence. The lightbox's `delta` is therefore a function of `dir`, not a constant. This is the one place where RTL changes behaviour rather than layout, and it lands in #405 in coordination with #399's shortcut registry.

**The sidebar moves.** `panel-left-open`/`panel-left-close` and the rail geometry are `inline-start`, not left — the sidebar is on the right in RTL, and both the glyph and its semantics invert.

### 6. Pseudo-locales and the hardcoded-string ratchet

**Two generated pseudo-locales, neither hand-maintained**, both derived from the `en` catalog at build:

- **`en-XA`** — accented and expanded (`[Ṕŕéṽíéŵ ~~~~]`): reveals unextracted strings (they render as plain ASCII), truncation, and layouts that assume English length.
- **`en-XB`** — bidi/RTL pseudo: exercises `dir` propagation, logical properties, and icon mirroring **with no translator**. This is what lets #405 gate RTL in CI. Shipping a real RTL _language_ waits on a reviewer (§7); RTL _correctness_ does not.

Both are dev/CI only and never ship in a release build.

**The ratchet** (per [ADR-0001](./ADR-0001-Automation-Check-Governance.md)): a lint rule flags user-facing literals; a committed per-file JSON budget records the known count and **only ever shrinks**. Unlisted files are budgeted at zero, so a new literal in a clean file fails without anyone remembering to add an entry. This deliberately mirrors the a11y violation budget (`tests/a11y/violation-budget.json`, #398) — same policy, same shape, one mental model. Seed: **~450–500**.

**Extraction joins the lint chain:** `formatjs extract` output must match the committed `en.json`, or the gate fails — the catalog cannot drift from the code. Note the two gates catch different things and both are needed: extraction sees only what is already wrapped in a message; the literal ratchet is what sees the strings that never got wrapped.

`.stories.tsx` are excluded from the ratchet — they are fixtures, consistent with how the lint config already treats `tests/fixtures/**`.

### 7. Launch locales and translation workflow

**`en` is the source catalog and the only language that ships at launch.** The machinery ships complete in #403–#405, so adding a locale is a data change, not an engineering one.

**Unreviewed machine translation is not shipped.** MT is welcome as a _draft_ for a human reviewer; it does not reach a release without a native speaker signing off. The reason is specific to this product rather than a general principle: Overlook's confirmations gate **irreversible, data-losing actions** — purge, offload, relock, delete, "this password cannot be reset or recovered". A mistranslated confirmation is a data-loss bug with a friendly face. Shipping a half-understood destructive dialog is worse than shipping English.

**Candidate first wave** when reviewers exist: `de`, `fr`, `es`, `ja`, plus one of `ar`/`he` to put a real RTL locale in front of users. Catalogs live in-repo (`src/shared/i18n/messages/<locale>.json`), review happens in PRs like any other change, and the workflow is documented on the wiki as part of the epic's exit criteria.

## Consequences

**Easier.**

- One mental model for messages _and_ formatting: everything is ICU/`Intl` through one `IntlShape`. `format.ts`'s three hand-rolled, en-US-locked, unit-wrong functions disappear.
- The main process stays out of it. Routing errors on `code` localises them _and_ fixes an accessibility defect (#398) _and_ stops leaking internal `Error` prose to users — three problems, one contract change.
- RTL is ~25–30 CSS declarations and a 5-name icon allowlist, gated in CI by `en-XB` with no translator in the loop.
- No new Dependabot caps; no polyfills; no CSP change.

**Harder.**

- **~450–500 extraction sites is the real cost of this epic**, and it is mechanical, unglamorous, and touches nearly every renderer file. The ratchet exists to make it finishable rather than perpetual.
- The casing sweep is three mechanisms deep and the 16 `.toUpperCase()` sites are invisible to both a CSS and a literal grep.
- The design's fixed-width mono chrome will not survive German or Arabic unchanged. Some layouts will have to give.
- Every E2E assertion on visible text becomes locale-dependent unless `OVERLOOK_LOCALE` pins it. That hook is a prerequisite for #404, not a nicety.

**Deviations from the epic, recorded rather than hidden.**

- #382's product rule says main-process strings come from the catalog. Main has one string and no menu or tray; we satisfy the rule's intent via the `code` contract and keep `@formatjs/intl` in reserve. If a menu lands, this section is what it cites — no refactor, just a consumer.

**Revisit when.**

- A user asks for UI language and region format to differ (§4) — the seam is `formats.ts`.
- An application menu, tray, or notification lands — main becomes a catalog consumer via `@formatjs/intl` (§1).
- React 19 migration — re-check `react-intl`'s peer range at that point, though it already allows `>=18`.
- A locale needs a calendar the stored Gregorian wall-clock cannot express (§4) — nothing today does; `fa-IR` renders Jalali from a Gregorian instant correctly.

## Amendment 2026-09-26 (#1287, UI-03): prose leaves `.mono-data`

§3 keeps its ruling: catalog strings are natural case, and casing is applied by CSS alone. What changes is which text `.mono-data` may carry. §3 and finding 27 of the 2026-07 accessibility audit treated prose inside `.mono-data` as acceptable, because CSS uppercased it. The 2026-09 UI audit found that mono sentences wrap badly and read slowly, and that the uppercase transform turns "24m ago" into "24M AGO".

- **`.mono-data` is for machine values only:** paths, file names, sizes, counts, hashes, EXIF values, absolute timestamps, key identifiers, and lines made only of such values joined by `·`. Short labels (field labels, section headings, eyebrows, badges) also stay mono uppercase.
- **Prose is sans and sentence case:** hints, notes, errors, status sentences, relative times, and lines that read as a phrase even when they contain a count ("3 of 12 selected"). These use the `.prose-note` utility or a component rule on the sans type scale.
- **Recased catalog strings.** Five `preview.*` messages, `lightbox.locked`, `inspector.custody.locked`, and `inspector.file.dimensionMismatch` were uppercase in source, contrary to §3. They are now sentence case. The key identifier inside them stays `KEY #{id}`, as §3 leaves identifiers literal.
