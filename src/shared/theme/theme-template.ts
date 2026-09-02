import { parseCssColor } from './css-color.js';
import {
  THEME_CONTRAST_PAIRS,
  THEME_TOKENS,
  THEME_TOKENS_VERSION,
  type ThemeContrastPair,
  type ThemeToken,
  type ThemeValidationError,
} from './theme-file.js';

/**
 * ADR-0019 §6: the annotated template is the authoritative, documented token
 * surface. Every allowlisted token carries one description (role, then where
 * it is used) so a person or a language model can author a theme without
 * reading component CSS.
 */
export const THEME_TOKEN_DOCS: Readonly<Record<ThemeToken, string>> = {
  '--gray-0': 'Deepest neutral. Window canvas behind photos; source of --surface-window.',
  '--gray-1': 'Panel neutral. Sidebar, toolbar, status bar, dialog bodies; source of --surface-panel.',
  '--gray-2': 'Card neutral. Cards, inputs, raised list rows; source of --surface-card.',
  '--gray-3': 'Hover neutral. Hover fills, popovers, menus; source of --surface-raised.',
  '--gray-4': 'Pressed neutral. Pressed fills and the scrollbar thumb.',
  '--gray-5': 'Strongest neutral interaction fill, such as a dragged or active control.',
  '--white-1': 'Primary text color; source of --text-body. Must stay readable on --gray-0 through --gray-3.',
  '--white-2': 'Secondary text color; source of --text-muted. Labels, captions, hints.',
  '--white-3': 'Faint text color; source of --text-faint. Disabled and tertiary text, still AA on --gray-3.',
  '--accent-iris': 'Primary brand accent. Selection, focus, primary buttons, active navigation, links.',
  '--accent-cyan': 'Legacy alias of --accent-iris. Override only when the two must differ.',
  '--accent-cyan-bright': 'Bright end of the brand gradient and cyan highlights in status glyphs.',
  '--accent-violet': 'Deep end of the brand gradient and the moodboard/lightbox brand ring.',
  '--accent-amber': 'Cloud, offloaded, pending, and sync-in-progress states.',
  '--accent-green': 'Encrypted, verified, and success states.',
  '--accent-red': 'Destructive actions, errors, and danger badges. Must stay AA over --accent-red-dim.',
  '--accent-iris-dim': 'Translucent iris fill behind selected rows, chips, and focus halos.',
  '--accent-cyan-dim': 'Legacy alias of --accent-iris-dim.',
  '--accent-amber-dim': 'Translucent amber fill behind cloud and sync badges.',
  '--accent-green-dim': 'Translucent green fill behind verified and success badges.',
  '--accent-red-dim': 'Translucent red fill behind destructive confirmations and error banners.',
  '--border-1': 'Default hairline between panels, rows, and inputs; source of --border-subtle.',
  '--border-2': 'Emphasized hairline for focused inputs, dividers, and active tabs.',
  '--border-subtle': 'Alias of --border-1 used by cards and list separators.',
  '--scrim': 'Modal and sheet backdrop laid over the whole window.',
  '--surface-photo-overlay': 'Opaque chrome drawn over photos: lightbox toolbar, tile badges. Stays dark in light themes.',
  '--surface-photo-overlay-soft': 'Light translucent chrome over photos, such as hover captions.',
  '--surface-photo-overlay-medium': 'Medium translucent chrome over photos, such as tile selection bars.',
  '--surface-photo-overlay-strong': 'Strong translucent chrome over photos, such as the lightbox filmstrip.',
  '--surface-photo-backdrop': 'Backdrop behind full-display images and protected previews.',
  '--border-photo-overlay': 'Hairline drawn on photo chrome, such as the focused tile outline.',
  '--text-photo-overlay': 'Primary text on photo chrome (badges, lightbox counters).',
  '--text-photo-muted': 'Secondary text on photo chrome.',
  '--text-photo-danger': 'Danger text on photo chrome, such as a failed-preview label.',
  '--border-photo-original': 'Outline of the Original preservation marker on tiles.',
  '--surface-photo-original': 'Fill of the Original preservation marker on tiles.',
  '--text-photo-original': 'Text of the Original preservation marker on tiles.',
  '--photo-hover-overlay': 'Translucent wash over a tile while hovered.',
  '--surface-window': 'Semantic window canvas. Defaults to --gray-0.',
  '--surface-panel': 'Semantic panel surface. Defaults to --gray-1.',
  '--surface-card': 'Semantic card and input surface. Defaults to --gray-2.',
  '--surface-raised': 'Semantic raised surface for popovers and hover. Defaults to --gray-3.',
  '--text-body': 'Semantic body text. Defaults to --white-1; must keep at least 1.5:1 against --surface-window.',
  '--text-muted': 'Semantic secondary text. Defaults to --white-2.',
  '--text-faint': 'Semantic faint text. Defaults to --white-3.',
  '--text-tertiary': 'Semantic tertiary text. Defaults to --text-faint.',
  '--text-on-accent': 'Text drawn on accent fills: primary buttons, selected chips, badges.',
  '--on-danger-strong': 'Text drawn on strong danger fills. Defaults to --text-on-accent.',
  '--btn-primary-hover': 'Primary button fill while hovered. Usually a lighter --accent-iris.',
  '--btn-primary-press': 'Primary button fill while pressed. Usually a darker --accent-iris.',
  '--text-over-danger': 'Text on destructive buttons.',
  '--selection': 'Text-selection and grid-selection color. Defaults to --accent-cyan.',
};

export interface ThemeTemplateInput {
  readonly base: 'dark' | 'light';
  /** Effective value of each allowlisted token in the running renderer. */
  readonly tokens: Readonly<Record<string, string>>;
}

export interface ThemeTemplateFile {
  readonly meta: {
    readonly name: string;
    readonly author: string;
    readonly version: string;
    readonly base: 'dark' | 'light';
    readonly tokensVersion: typeof THEME_TOKENS_VERSION;
  };
  readonly tokens: Readonly<Record<ThemeToken, string>>;
  readonly docs: Readonly<Record<ThemeToken, string>>;
  /** ADR-0019 §4: the exact pairs the importer checks, with their thresholds. */
  readonly contrastPairs: readonly ThemeContrastPair[];
}

export type ThemeTemplateResult =
  { readonly ok: true; readonly template: ThemeTemplateFile } | { readonly ok: false; readonly errors: readonly ThemeValidationError[] };

/**
 * Build the annotated template from the renderer's effective token values.
 * Every allowlisted token must be present and parse as one literal CSS color;
 * forced-colors keywords and unresolved `var()` references fail closed so the
 * exported file is always importable without edits.
 */
export function buildThemeTemplate(input: ThemeTemplateInput): ThemeTemplateResult {
  const errors: ThemeValidationError[] = [];
  const tokens: Partial<Record<ThemeToken, string>> = {};
  for (const token of THEME_TOKENS) {
    const value = input.tokens[token]?.trim() ?? '';
    if (value === '') {
      errors.push({ path: `tokens.${token}`, message: `${token} has no effective value to export` });
      continue;
    }
    try {
      parseCssColor(value);
      tokens[token] = value;
    } catch (error) {
      errors.push({ path: `tokens.${token}`, message: error instanceof Error ? error.message : 'Invalid CSS color' });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    template: {
      meta: {
        name: input.base === 'dark' ? 'Overlook dark template' : 'Overlook light template',
        author: 'Overlook',
        version: '1.0.0',
        base: input.base,
        tokensVersion: THEME_TOKENS_VERSION,
      },
      tokens: tokens as Record<ThemeToken, string>,
      docs: THEME_TOKEN_DOCS,
      contrastPairs: THEME_CONTRAST_PAIRS,
    },
  };
}
