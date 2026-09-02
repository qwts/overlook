# Theming reference

Overlook lets you replace its colors with a `*.overlook-theme.json` file. This
page is the contract for that file: the format, every token you may set, the
validation rules, and the fastest workflow — export a template from a running
copy of Overlook, hand it to a person or an LLM, import the result. The runtime
rules come from
[ADR-0019 User theme contract](./adr/ADR-0019-User-Theme-Contract.md);
the Settings UI is verified by
[Appearance themes acceptance](./acceptance/Acceptance-Test-Appearance-Themes.md).

## Fast path: export, edit, import

1. Open **Settings → General → Custom themes** and choose **Export theme
   template**. Overlook writes a complete file containing the effective value of
   every user-themable token for the theme you are currently looking at (Dark,
   Light, or an active custom theme), plus a one-line description of each token.
2. Edit the file — by hand, or by pasting it into an LLM with the prompt below.
   Delete any token you do not want to override; Overlook fills the rest from
   the declared `base`.
3. Import the file through the same panel (picker or drag-drop). Overlook
   validates it, shows contrast warnings, previews it, and only keeps it once you
   confirm.

Importing the exported template unchanged is a no-op: the template reproduces
the current rendering exactly, so it is a safe starting point.

## File format

```json
{
  "meta": {
    "name": "Solarized Dusk",
    "author": "You",
    "version": "1.0.0",
    "base": "dark",
    "tokensVersion": 1
  },
  "tokens": {
    "--surface-window": "#002b36",
    "--text-body": "#eee8d5",
    "--accent-iris": "#4aa3e0"
  },
  "docs": {
    "--surface-window": "Semantic window canvas. Defaults to --gray-0."
  },
  "contrastPairs": [{ "foreground": "--text-body", "background": "--surface-window", "warnAt": 4.5, "blockAt": 1.5 }]
}
```

- `meta.name`, `meta.author`, `meta.version` are display strings (1–80
  characters; `version` is semver).
- `meta.base` is `dark` or `light` and selects the first-party theme that fills
  every token you leave out.
- `meta.tokensVersion` is the schema version. Only `1` is accepted.
- `tokens` is a map of token name → literal CSS color. Every value must be a
  single color in hex, `rgb()`, `hsl()`, `oklch()`, or `color()` form. `var()`,
  `url()`, `@import`, semicolons, braces, and forced-colors keywords such as
  `Canvas` are rejected. Unknown token names are ignored with a warning.
- `docs` is optional, reserved, and ignored by the importer. The exporter fills
  it so the file explains itself; keep or drop it as you like.
- `contrastPairs` is optional, reserved, and ignored by the importer. The
  exporter fills it with the exact foreground/background pairs and thresholds
  the validator checks ([validation rules](#validation-rules)), generated from
  the same list the validator uses, so an author or a language model can see
  what will be measured.
  Editing it changes nothing: the importer always checks its own list.
- Files must use the `.overlook-theme.json` suffix and stay under 256 KiB.

## Validation rules

Overlook validates before anything is written to the profile:

| Check                                            | Outcome                        |
| ------------------------------------------------ | ------------------------------ |
| Schema, suffix, size, JSON, literal-color values | Rejected with a path and cause |
| `--text-body` vs any surface below 1.5:1         | Rejected (invisible text)      |
| Any text/surface or accent pair below 4.5:1      | Imported with a named warning  |
| Unknown token                                    | Imported with a warning        |

The checked pairs are every `--text-*` semantic token against every
`--surface-*` token, `--text-on-accent` against each accent, and
`--accent-cyan` against `--surface-window`; the exported template lists them
verbatim under `contrastPairs`.

Warnings are shown in the manager list and in the preview dialog before you can
keep the theme. The exporter applies the same validator to the file it writes,
so a template can never fail to import on the machine that produced it.

## Token reference

Every token below may appear under `tokens`. Names are exactly as in the
renderer stylesheet. "Source of" means a semantic token defaults to that value
when you do not set the semantic token explicitly.

### Neutrals and text sources

| Token       | Role                                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| `--gray-0`  | Deepest neutral. Window canvas behind photos; source of `--surface-window`.        |
| `--gray-1`  | Panel neutral. Sidebar, toolbar, status bar, dialogs; source of `--surface-panel`. |
| `--gray-2`  | Card neutral. Cards, inputs, raised list rows; source of `--surface-card`.         |
| `--gray-3`  | Hover neutral. Hover fills, popovers, menus; source of `--surface-raised`.         |
| `--gray-4`  | Pressed neutral. Pressed fills and the scrollbar thumb.                            |
| `--gray-5`  | Strongest neutral interaction fill, such as a dragged or active control.           |
| `--white-1` | Primary text; source of `--text-body`. Readable on `--gray-0` … `--gray-3`.        |
| `--white-2` | Secondary text; source of `--text-muted`. Labels, captions, hints.                 |
| `--white-3` | Faint text; source of `--text-faint`. Disabled and tertiary text.                  |

### Accents

| Token                  | Role                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `--accent-iris`        | Primary brand accent. Selection, focus, primary buttons, links.          |
| `--accent-cyan`        | Legacy alias of `--accent-iris`. Override only when the two must differ. |
| `--accent-cyan-bright` | Bright end of the brand gradient and cyan highlights in status glyphs.   |
| `--accent-violet`      | Deep end of the brand gradient and the moodboard/lightbox brand ring.    |
| `--accent-amber`       | Cloud, offloaded, pending, and sync-in-progress states.                  |
| `--accent-green`       | Encrypted, verified, and success states.                                 |
| `--accent-red`         | Destructive actions, errors, danger badges. AA over `--accent-red-dim`.  |
| `--accent-iris-dim`    | Translucent iris fill behind selected rows, chips, and focus halos.      |
| `--accent-cyan-dim`    | Legacy alias of `--accent-iris-dim`.                                     |
| `--accent-amber-dim`   | Translucent amber fill behind cloud and sync badges.                     |
| `--accent-green-dim`   | Translucent green fill behind verified and success badges.               |
| `--accent-red-dim`     | Translucent red fill behind destructive confirmations and error banners. |

### Borders and backdrop

| Token             | Role                                                                        |
| ----------------- | --------------------------------------------------------------------------- |
| `--border-1`      | Default hairline between panels, rows, inputs; source of `--border-subtle`. |
| `--border-2`      | Emphasized hairline for focused inputs, dividers, and active tabs.          |
| `--border-subtle` | Alias of `--border-1` used by cards and list separators.                    |
| `--scrim`         | Modal and sheet backdrop laid over the whole window.                        |

### Photo chrome

These stay dark in light themes so controls remain legible over any image.

| Token                            | Role                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `--surface-photo-overlay`        | Opaque chrome over photos: lightbox toolbar, tile badges.     |
| `--surface-photo-overlay-soft`   | Light translucent chrome over photos, such as hover captions. |
| `--surface-photo-overlay-medium` | Medium translucent chrome, such as tile selection bars.       |
| `--surface-photo-overlay-strong` | Strong translucent chrome, such as the lightbox filmstrip.    |
| `--surface-photo-backdrop`       | Backdrop behind full-display images and protected previews.   |
| `--border-photo-overlay`         | Hairline on photo chrome, such as the focused tile outline.   |
| `--text-photo-overlay`           | Primary text on photo chrome (badges, lightbox counters).     |
| `--text-photo-muted`             | Secondary text on photo chrome.                               |
| `--text-photo-danger`            | Danger text on photo chrome, such as a failed-preview label.  |
| `--border-photo-original`        | Outline of the Original preservation marker on tiles.         |
| `--surface-photo-original`       | Fill of the Original preservation marker on tiles.            |
| `--text-photo-original`          | Text of the Original preservation marker on tiles.            |
| `--photo-hover-overlay`          | Translucent wash over a tile while hovered.                   |

### Semantic surfaces, text, and controls

| Token                 | Role                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| `--surface-window`    | Window canvas. Defaults to `--gray-0`.                                         |
| `--surface-panel`     | Panel surface. Defaults to `--gray-1`.                                         |
| `--surface-card`      | Card and input surface. Defaults to `--gray-2`.                                |
| `--surface-raised`    | Raised surface for popovers and hover. Defaults to `--gray-3`.                 |
| `--text-body`         | Body text. Defaults to `--white-1`; at least 1.5:1 against `--surface-window`. |
| `--text-muted`        | Secondary text. Defaults to `--white-2`.                                       |
| `--text-faint`        | Faint text. Defaults to `--white-3`.                                           |
| `--text-tertiary`     | Tertiary text. Defaults to `--text-faint`.                                     |
| `--text-on-accent`    | Text on accent fills: primary buttons, selected chips, badges.                 |
| `--on-danger-strong`  | Text on strong danger fills. Defaults to `--text-on-accent`.                   |
| `--btn-primary-hover` | Primary button fill while hovered. Usually a lighter `--accent-iris`.          |
| `--btn-primary-press` | Primary button fill while pressed. Usually a darker `--accent-iris`.           |
| `--text-over-danger`  | Text on destructive buttons.                                                   |
| `--selection`         | Text-selection and grid-selection color. Defaults to `--accent-cyan`.          |

The exporter embeds the same descriptions under `docs`; the unit test
`tests/theme/theme-template.test.ts` fails if this page and the exporter ever
disagree about the token list.

## Example themes

Two partial themes live under [`docs/themes/`](./themes/) and are validated in
CI to import without warnings:

- [`solarized-dusk.overlook-theme.json`](./themes/solarized-dusk.overlook-theme.json)
  — a dark base with Solarized surfaces and accents.
- [`paper.overlook-theme.json`](./themes/paper.overlook-theme.json) — a warm
  light base with deep, AA-safe accents.

Both leave photo chrome and the neutral ramp alone, which is the recommended
starting point: set the four surfaces, the three text levels, the accents you
care about, and `--text-on-accent`, then let the base fill the rest.

## Prompt for an LLM

Paste the exported template after this prompt:

> This JSON is an Overlook theme template. Each key under `tokens` is a CSS
> custom property and `docs` explains what it paints. Produce a new theme in the
> same format for the palette I describe. Rules: keep `meta.tokensVersion` at
> 1; set `meta.base` to `dark` or `light` to match the palette; every value must
> be one literal CSS color (hex, `rgb()`, `hsl()`, `oklch()`, or `color()`) with
> no `var()`, keywords, or references; keep `--text-body` at 4.5:1 or better
> against all four `--surface-*` tokens; keep `--text-on-accent` at 4.5:1 or
> better against every `--accent-*` token; keep translucent `-dim` and
> `--scrim` values translucent; omit tokens you want to inherit; you may drop
> the `docs` block. Return only the JSON.

## Recovery

If a theme leaves the window unreadable, choose **View → Reset Appearance**
(Command/Control+Option/Alt+Shift+R) or launch once with `--reset-theme`. Both
work without renderer cooperation and restore the first-party Dark theme.
