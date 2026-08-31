import { oklchToSrgb, srgb, type SrgbColor } from './contrast.js';

export interface ParsedCssColor {
  readonly srgb: SrgbColor;
  readonly alpha: number;
  /** Canonical, injection-safe serialization generated only from numbers. */
  readonly css: string;
}

const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;

function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return value;
}

function numeric(value: string, label: string): number {
  if (!new RegExp(`^${NUMBER}$`, 'i').test(value)) throw new Error(`${label} is not a number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function percentage(value: string, label: string): number {
  if (!value.endsWith('%')) throw new Error(`${label} must be a percentage`);
  return bounded(numeric(value.slice(0, -1), label), 0, 100, label) / 100;
}

function alpha(value: string | undefined): number {
  if (value === undefined) return 1;
  return value.endsWith('%') ? percentage(value, 'alpha') : bounded(numeric(value, 'alpha'), 0, 1, 'alpha');
}

function canonical(color: SrgbColor, opacity: number): ParsedCssColor {
  const rounded = color.map((channel) => Number((channel * 100).toFixed(5))) as [number, number, number];
  const suffix = opacity === 1 ? '' : ` / ${Number(opacity.toFixed(5))}`;
  return { srgb: color, alpha: opacity, css: `rgb(${rounded[0]}% ${rounded[1]}% ${rounded[2]}%${suffix})` };
}

function parseHex(value: string): ParsedCssColor | null {
  const match = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(value);
  if (match === null) return null;
  const hex = match[1] ?? '';
  const expanded = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const channels = [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  const opacity = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
  return canonical(srgb(...channels), opacity);
}

function splitSlash(body: string): readonly [string, string | undefined] {
  const parts = body.split('/').map((part) => part.trim());
  if (parts.length > 2 || parts[0] === '') throw new Error('invalid color channel list');
  return [parts[0] ?? '', parts[1]];
}

function rgbChannel(value: string): number {
  return value.endsWith('%') ? percentage(value, 'RGB channel') : bounded(numeric(value, 'RGB channel'), 0, 255, 'RGB channel') / 255;
}

function parseRgb(body: string): ParsedCssColor {
  if (body.includes(',')) {
    const parts = body.split(',').map((part) => part.trim());
    if (parts.length !== 3 && parts.length !== 4) throw new Error('rgb() requires three channels and optional alpha');
    return canonical(srgb(rgbChannel(parts[0] ?? ''), rgbChannel(parts[1] ?? ''), rgbChannel(parts[2] ?? '')), alpha(parts[3]));
  }
  const [channels, opacity] = splitSlash(body);
  const parts = channels.split(/\s+/);
  if (parts.length !== 3) throw new Error('rgb() requires three channels');
  return canonical(srgb(rgbChannel(parts[0] ?? ''), rgbChannel(parts[1] ?? ''), rgbChannel(parts[2] ?? '')), alpha(opacity));
}

function hue(value: string): number {
  const match = new RegExp(`^(${NUMBER})(deg|grad|rad|turn)?$`, 'i').exec(value);
  if (match === null) throw new Error('hue must be an angle');
  const amount = numeric(match[1] ?? '', 'hue');
  const degrees =
    match[2]?.toLowerCase() === 'turn'
      ? amount * 360
      : match[2]?.toLowerCase() === 'rad'
        ? (amount * 180) / Math.PI
        : match[2]?.toLowerCase() === 'grad'
          ? amount * 0.9
          : amount;
  return ((degrees % 360) + 360) % 360;
}

function hslToSrgb(hueDegrees: number, saturation: number, lightness: number): SrgbColor {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hueDegrees / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] =
    section < 1
      ? [chroma, secondary, 0]
      : section < 2
        ? [secondary, chroma, 0]
        : section < 3
          ? [0, chroma, secondary]
          : section < 4
            ? [0, secondary, chroma]
            : section < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return srgb(red + match, green + match, blue + match);
}

function parseHsl(body: string): ParsedCssColor {
  const legacy = body.includes(',');
  const [channels, opacity] = legacy ? [body, undefined] : splitSlash(body);
  const parts = channels.split(legacy ? /\s*,\s*/ : /\s+/);
  if (parts.length !== 3 && !(legacy && parts.length === 4)) throw new Error('hsl() requires hue, saturation, and lightness');
  return canonical(
    hslToSrgb(hue(parts[0] ?? ''), percentage(parts[1] ?? '', 'saturation'), percentage(parts[2] ?? '', 'lightness')),
    alpha(legacy ? parts[3] : opacity),
  );
}

function parseOklch(body: string): ParsedCssColor {
  const [channels, opacity] = splitSlash(body);
  const parts = channels.split(/\s+/);
  if (parts.length !== 3) throw new Error('oklch() requires lightness, chroma, and hue');
  const lightness = (parts[0] ?? '').endsWith('%')
    ? percentage(parts[0] ?? '', 'lightness')
    : bounded(numeric(parts[0] ?? '', 'lightness'), 0, 1, 'lightness');
  const chroma = (parts[1] ?? '').endsWith('%')
    ? percentage(parts[1] ?? '', 'chroma') * 0.4
    : bounded(numeric(parts[1] ?? '', 'chroma'), 0, 0.4, 'chroma');
  return canonical(oklchToSrgb(lightness, chroma, hue(parts[2] ?? '')), alpha(opacity));
}

function decode(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encode(value: number): number {
  const boundedValue = Math.min(1, Math.max(0, value));
  return boundedValue <= 0.003_130_8 ? boundedValue * 12.92 : 1.055 * boundedValue ** (1 / 2.4) - 0.055;
}

function colorChannel(value: string): number {
  return value.endsWith('%') ? percentage(value, 'color channel') : bounded(numeric(value, 'color channel'), 0, 1, 'color channel');
}

function displayP3ToSrgb(red: number, green: number, blue: number): SrgbColor {
  const [r, g, b] = [red, green, blue].map(decode) as [number, number, number];
  return srgb(
    encode(1.224_745 * r - 0.224_904 * g - 0.000_041 * b),
    encode(-0.042_058 * r + 1.042_081 * g - 0.000_079 * b),
    encode(-0.019_642 * r - 0.078_655 * g + 1.098_537 * b),
  );
}

function parseColorFunction(body: string): ParsedCssColor {
  const [channels, opacity] = splitSlash(body);
  const parts = channels.split(/\s+/);
  if (parts.length !== 4) throw new Error('color() requires a color space and three channels');
  const values = parts.slice(1).map(colorChannel) as [number, number, number];
  const space = parts[0]?.toLowerCase();
  if (space !== 'srgb' && space !== 'display-p3') throw new Error(`unsupported color() space ${space ?? ''}`.trim());
  return canonical(space === 'srgb' ? srgb(...values) : displayP3ToSrgb(...values), alpha(opacity));
}

/** Parse one bounded CSS color grammar; no source text is retained. */
export function parseCssColor(input: string): ParsedCssColor {
  const value = input.trim();
  if (value.length === 0 || value.length > 160) throw new Error('color must contain 1–160 characters');
  if (/[{};@"'\\]|\b(?:url|var|calc|image|expression)\s*\(/i.test(value)) throw new Error('only a single literal CSS color is allowed');
  const hex = parseHex(value);
  if (hex !== null) return hex;
  const match = /^([a-z]+)\(([^()]*)\)$/i.exec(value);
  if (match === null) throw new Error('expected hex, rgb(), hsl(), oklch(), or color()');
  const name = match[1]?.toLowerCase();
  const body = match[2] ?? '';
  if (name === 'rgb' || name === 'rgba') return parseRgb(body);
  if (name === 'hsl' || name === 'hsla') return parseHsl(body);
  if (name === 'oklch') return parseOklch(body);
  if (name === 'color') return parseColorFunction(body);
  throw new Error(`unsupported color function ${name ?? ''}()`.trim());
}

export function compositeColor(foreground: ParsedCssColor, background: ParsedCssColor): ParsedCssColor {
  const opacity = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (opacity === 0) return canonical(srgb(0, 0, 0), 0);
  return canonical(
    srgb(
      ...(foreground.srgb.map(
        (channel, index) =>
          (channel * foreground.alpha + (background.srgb[index] ?? 0) * background.alpha * (1 - foreground.alpha)) / opacity,
      ) as [number, number, number]),
    ),
    opacity,
  );
}
