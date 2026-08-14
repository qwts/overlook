#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { contrastRatio, oklchToSrgb, srgb } from '../src/shared/theme/contrast.ts';

const COLOR_TOKENS = 'src/renderer/src/styles/tokens/colors.css';
const PAIRS = [
  ...['--text-body', '--text-muted', '--text-faint'].flatMap((foreground) =>
    ['--surface-window', '--surface-panel', '--surface-card', '--surface-raised'].map((background) => ({
      foreground,
      background,
      minimum: 4.5,
    })),
  ),
  ...['--accent-iris', '--accent-cyan-bright', '--accent-violet', '--accent-amber', '--accent-green', '--accent-red'].map((background) => ({
    foreground: '--text-on-accent',
    background,
    minimum: 4.5,
  })),
  ...['--accent-iris', '--accent-amber', '--accent-green', '--accent-red'].flatMap((foreground) =>
    ['--surface-window', '--surface-panel', '--surface-card', '--surface-raised'].map((background) => ({
      foreground,
      background,
      minimum: 3,
    })),
  ),
];
const HIGH_CONTRAST_PAIRS = [
  ...['--border-1', '--border-2', '--selection'].flatMap((foreground) =>
    ['--surface-window', '--surface-panel', '--surface-card', '--surface-raised'].map((background) => ({
      foreground,
      background,
      minimum: 3,
    })),
  ),
  ...['--btn-primary-hover', '--btn-primary-press'].map((background) => ({
    foreground: '--text-on-accent',
    background,
    minimum: 4.5,
  })),
  { foreground: '--text-photo-overlay', background: '--surface-photo-overlay', minimum: 4.5 },
  { foreground: '--border-photo-overlay', background: '--surface-photo-overlay', minimum: 3 },
];

function declarations(body) {
  return new Map([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gimu)].map((match) => [match[1], match[2].trim()]));
}

function declarationsForSelector(source, selector) {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'imu').exec(source);
  return match === null ? new Map() : declarations(match[1]);
}

function themes(source) {
  const base = declarationsForSelector(source, ':root');
  const light = declarationsForSelector(source, ":root[data-theme='light']");
  const highContrast = declarationsForSelector(source, ":root[data-contrast='more']");
  const lightHighContrast = declarationsForSelector(source, ":root[data-theme='light'][data-contrast='more']");
  return new Map([
    ['dark', base],
    ['light', new Map([...base, ...light])],
    ['dark-high-contrast', new Map([...base, ...highContrast])],
    ['light-high-contrast', new Map([...base, ...light, ...highContrast, ...lightHighContrast])],
  ]);
}

function resolveToken(values, token, seen = new Set()) {
  if (seen.has(token)) throw new Error(`Token cycle while resolving ${token}`);
  const value = values.get(token);
  if (value === undefined) throw new Error(`Missing declared color token ${token}`);
  const alias = /^var\((--[a-z0-9-]+)\)$/iu.exec(value);
  if (alias === null) return value;
  return resolveToken(values, alias[1], new Set([...seen, token]));
}

function parseColor(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value);
  if (hex !== null) {
    const expanded = hex[1].length === 3 ? [...hex[1]].map((digit) => `${digit}${digit}`).join('') : hex[1];
    return srgb(
      Number.parseInt(expanded.slice(0, 2), 16) / 255,
      Number.parseInt(expanded.slice(2, 4), 16) / 255,
      Number.parseInt(expanded.slice(4, 6), 16) / 255,
    );
  }
  const rgb = /^rgb\(\s*([\d.]+)%?\s+([\d.]+)%?\s+([\d.]+)%?\s*\)$/iu.exec(value);
  if (rgb !== null) {
    const percent = value.includes('%');
    const scale = percent ? 100 : 255;
    return srgb(Number(rgb[1]) / scale, Number(rgb[2]) / scale, Number(rgb[3]) / scale);
  }
  const oklch = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/iu.exec(value);
  if (oklch !== null) return oklchToSrgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  throw new Error(`Unsupported solid color syntax: ${value}`);
}

export function evaluateColorContrast(source) {
  const themeValues = themes(source);
  const failures = [];
  let checks = 0;
  for (const [theme, values] of themeValues) {
    const pairs = theme.endsWith('-high-contrast') ? [...PAIRS, ...HIGH_CONTRAST_PAIRS] : PAIRS;
    for (const pair of pairs) {
      const foreground = parseColor(resolveToken(values, pair.foreground));
      const background = parseColor(resolveToken(values, pair.background));
      const ratio = contrastRatio(foreground, background);
      checks += 1;
      if (ratio + Number.EPSILON < pair.minimum) {
        failures.push(`${theme}: ${pair.foreground} on ${pair.background} = ${ratio.toFixed(2)}:1; needs ${pair.minimum.toFixed(1)}:1`);
      }
    }
  }
  return { checks, themes: [...themeValues.keys()], failures };
}

async function main() {
  const source = await readFile(path.resolve(process.cwd(), COLOR_TOKENS), 'utf8');
  const result = evaluateColorContrast(source);
  if (result.failures.length > 0) {
    console.error('Declared color contrast check failed:');
    for (const failure of result.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Declared color contrast check OK: ${String(result.checks)} semantic pairs across ${String(result.themes.length)} theme(s).`,
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
