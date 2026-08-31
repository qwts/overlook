import { z } from 'zod';

import { contrastRatio } from './contrast.js';
import { compositeColor, parseCssColor, type ParsedCssColor } from './css-color.js';

export const THEME_TOKENS = [
  '--gray-0',
  '--gray-1',
  '--gray-2',
  '--gray-3',
  '--gray-4',
  '--gray-5',
  '--white-1',
  '--white-2',
  '--white-3',
  '--accent-iris',
  '--accent-cyan',
  '--accent-cyan-bright',
  '--accent-violet',
  '--accent-amber',
  '--accent-green',
  '--accent-red',
  '--accent-iris-dim',
  '--accent-cyan-dim',
  '--accent-amber-dim',
  '--accent-green-dim',
  '--accent-red-dim',
  '--border-1',
  '--border-2',
  '--border-subtle',
  '--scrim',
  '--surface-photo-overlay',
  '--surface-photo-overlay-soft',
  '--surface-photo-overlay-medium',
  '--surface-photo-overlay-strong',
  '--surface-photo-backdrop',
  '--border-photo-overlay',
  '--text-photo-overlay',
  '--text-photo-muted',
  '--text-photo-danger',
  '--border-photo-original',
  '--surface-photo-original',
  '--text-photo-original',
  '--photo-hover-overlay',
  '--surface-window',
  '--surface-panel',
  '--surface-card',
  '--surface-raised',
  '--text-body',
  '--text-muted',
  '--text-faint',
  '--text-tertiary',
  '--text-on-accent',
  '--on-danger-strong',
  '--btn-primary-hover',
  '--btn-primary-press',
  '--text-over-danger',
  '--selection',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export const THEME_TOKENS_VERSION = 1 as const;
export const themeIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/, 'Invalid theme id');

export const themeMetaSchema = z
  .object({
    name: z.string().min(1).max(80),
    author: z.string().max(120).optional(),
    version: z
      .string()
      .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'Expected a semantic version'),
    base: z.enum(['dark', 'light']),
    tokensVersion: z.literal(THEME_TOKENS_VERSION),
  })
  .strict();

export const themeFileSchema = z
  .object({
    meta: themeMetaSchema,
    tokens: z.record(z.string(), z.string()),
    /** Reserved for the annotated template shipped by #397. Never applied. */
    docs: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const themeValidationErrorSchema = z.object({ path: z.string(), message: z.string() });
export const themeWarningSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unknown-token'), token: z.string(), message: z.string() }),
  z.object({
    kind: z.literal('contrast'),
    foreground: z.string(),
    background: z.string(),
    ratio: z.number(),
    message: z.string(),
  }),
]);

export type ThemeValidationError = z.output<typeof themeValidationErrorSchema>;
export type ThemeWarning = z.output<typeof themeWarningSchema>;

export interface ParsedThemeFile {
  readonly meta: z.output<typeof themeMetaSchema>;
  readonly tokens: Readonly<Partial<Record<ThemeToken, ParsedCssColor>>>;
  readonly cssTokens: Readonly<Partial<Record<ThemeToken, string>>>;
  readonly warnings: readonly ThemeWarning[];
}

export type ThemeValidationResult =
  { readonly ok: true; readonly theme: ParsedThemeFile } | { readonly ok: false; readonly errors: readonly ThemeValidationError[] };

const tokenSet = new Set<string>(THEME_TOKENS);
const aliasTargets: Readonly<Partial<Record<ThemeToken, ThemeToken>>> = {
  '--accent-cyan': '--accent-iris',
  '--accent-cyan-dim': '--accent-iris-dim',
  '--border-subtle': '--border-1',
  '--surface-window': '--gray-0',
  '--surface-panel': '--gray-1',
  '--surface-card': '--gray-2',
  '--surface-raised': '--gray-3',
  '--text-body': '--white-1',
  '--text-muted': '--white-2',
  '--text-faint': '--white-3',
  '--text-tertiary': '--text-faint',
  '--on-danger-strong': '--text-on-accent',
  '--selection': '--accent-cyan',
};

const baseValues = {
  dark: {
    '--gray-0': 'oklch(0.125 0.006 250)',
    '--gray-1': 'oklch(0.165 0.007 250)',
    '--gray-2': 'oklch(0.205 0.008 250)',
    '--gray-3': 'oklch(0.255 0.009 250)',
    '--white-1': 'oklch(0.955 0.004 250)',
    '--white-2': 'oklch(0.74 0.008 250)',
    '--white-3': 'oklch(0.64 0.01 250)',
    '--accent-iris': 'oklch(0.7 0.16 278)',
    '--accent-cyan-bright': 'oklch(0.8 0.13 218)',
    '--accent-violet': 'oklch(0.62 0.2 305)',
    '--accent-amber': 'oklch(0.74 0.125 75)',
    '--accent-green': 'oklch(0.74 0.125 155)',
    '--accent-red': 'oklch(0.74 0.19 25)',
    '--text-on-accent': 'oklch(0.14 0.01 250)',
  },
  light: {
    '--gray-0': '#f7f8fa',
    '--gray-1': '#eff1f5',
    '--gray-2': '#e5e8ee',
    '--gray-3': '#d8dce5',
    '--white-1': '#171a21',
    '--white-2': '#3f4653',
    '--white-3': '#46505f',
    '--accent-iris': '#5346c7',
    '--accent-cyan-bright': '#007d96',
    '--accent-violet': '#783caf',
    '--accent-amber': '#815000',
    '--accent-green': '#125e3b',
    '--accent-red': '#8f1020',
    '--text-on-accent': '#ffffff',
  },
} as const;

const textTokens = ['--text-body', '--text-muted', '--text-faint', '--text-tertiary'] as const;
const surfaceTokens = ['--surface-window', '--surface-panel', '--surface-card', '--surface-raised'] as const;
const accentTokens = [
  '--accent-iris',
  '--accent-cyan-bright',
  '--accent-violet',
  '--accent-amber',
  '--accent-green',
  '--accent-red',
] as const;

function zodErrors(error: z.ZodError): ThemeValidationError[] {
  return error.issues.map((issue) => ({ path: issue.path.length === 0 ? '$' : issue.path.join('.'), message: issue.message }));
}

function effectiveColor(
  token: ThemeToken,
  overrides: Readonly<Partial<Record<ThemeToken, ParsedCssColor>>>,
  base: 'dark' | 'light',
  seen = new Set<ThemeToken>(),
): ParsedCssColor | undefined {
  const override = overrides[token];
  if (override !== undefined) return override;
  if (seen.has(token)) return undefined;
  seen.add(token);
  const alias = aliasTargets[token];
  if (alias !== undefined) return effectiveColor(alias, overrides, base, seen);
  const value = baseValues[base][token as keyof (typeof baseValues)[typeof base]];
  return value === undefined ? undefined : parseCssColor(value);
}

function ratioOf(foreground: ParsedCssColor, background: ParsedCssColor): number {
  const backing = parseCssColor('#ffffff');
  const renderedBackground = compositeColor(background, backing);
  const renderedForeground = compositeColor(compositeColor(foreground, background), backing);
  return contrastRatio(renderedForeground.srgb, renderedBackground.srgb);
}

function contrastVerdicts(
  overrides: Readonly<Partial<Record<ThemeToken, ParsedCssColor>>>,
  base: 'dark' | 'light',
): { readonly warnings: ThemeWarning[]; readonly errors: ThemeValidationError[] } {
  const warnings: ThemeWarning[] = [];
  const errors: ThemeValidationError[] = [];
  const inspect = (foregroundToken: ThemeToken, backgroundToken: ThemeToken, warnAt: number, blockAt?: number): void => {
    const foreground = effectiveColor(foregroundToken, overrides, base);
    const background = effectiveColor(backgroundToken, overrides, base);
    if (foreground === undefined || background === undefined) return;
    const ratio = Number(ratioOf(foreground, background).toFixed(2));
    if (blockAt !== undefined && ratio < blockAt) {
      errors.push({
        path: `tokens.${foregroundToken}`,
        message: `${foregroundToken} / ${backgroundToken} contrast is ${ratio}:1; minimum is ${blockAt}:1`,
      });
    } else if (ratio < warnAt) {
      warnings.push({
        kind: 'contrast',
        foreground: foregroundToken,
        background: backgroundToken,
        ratio,
        message: `${foregroundToken} / ${backgroundToken} contrast is ${ratio}:1; AA guidance is ${warnAt}:1`,
      });
    }
  };
  for (const text of textTokens) for (const surface of surfaceTokens) inspect(text, surface, 4.5, text === '--text-body' ? 1.5 : undefined);
  for (const accent of accentTokens) inspect('--text-on-accent', accent, 4.5);
  inspect('--accent-cyan', '--surface-window', 4.5);
  return { warnings, errors };
}

export function validateThemeFile(input: unknown): ThemeValidationResult {
  const parsedFile = themeFileSchema.safeParse(input);
  if (!parsedFile.success) return { ok: false, errors: zodErrors(parsedFile.error) };
  const tokens: Partial<Record<ThemeToken, ParsedCssColor>> = {};
  const warnings: ThemeWarning[] = [];
  const errors: ThemeValidationError[] = [];
  for (const [token, value] of Object.entries(parsedFile.data.tokens)) {
    if (!tokenSet.has(token)) {
      warnings.push({ kind: 'unknown-token', token, message: `${token} is unknown and will be skipped` });
      continue;
    }
    try {
      tokens[token as ThemeToken] = parseCssColor(value);
    } catch (error) {
      errors.push({ path: `tokens.${token}`, message: error instanceof Error ? error.message : 'Invalid CSS color' });
    }
  }
  if (Object.keys(tokens).length === 0 && errors.length === 0)
    errors.push({ path: 'tokens', message: 'Theme must contain at least one recognized color token' });
  if (errors.length > 0) return { ok: false, errors };
  const contrast = contrastVerdicts(tokens, parsedFile.data.meta.base);
  if (contrast.errors.length > 0) return { ok: false, errors: contrast.errors };
  return {
    ok: true,
    theme: {
      meta: parsedFile.data.meta,
      tokens,
      cssTokens: Object.fromEntries(Object.entries(tokens).map(([token, color]) => [token, color.css])),
      warnings: [...warnings, ...contrast.warnings],
    },
  };
}
