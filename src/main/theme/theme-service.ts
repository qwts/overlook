import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ApplicableTheme, InstalledTheme, ThemeImportResult } from '../../shared/ipc/theme-channels.js';
import type { AppSettings, SettingsPatch } from '../../shared/settings/settings.js';
import { themeIdSchema, validateThemeFile, type ParsedThemeFile, type ThemeValidationError } from '../../shared/theme/theme-file.js';

const THEME_SUFFIX = '.overlook-theme.json';
const MAX_THEME_BYTES = 256 * 1024;
export const THEME_PREVIEW_MS = 15_000;

export interface ThemeSettingsStore {
  get(): AppSettings;
  set(patch: SettingsPatch): AppSettings;
}

interface PreviewSession {
  readonly id: string;
  readonly senderId: number;
  readonly theme: ApplicableTheme;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  healthy: boolean;
}

interface ReadThemeSuccess {
  readonly ok: true;
  readonly theme: ParsedThemeFile;
  readonly bytes: Buffer;
}

type ReadThemeResult = ReadThemeSuccess | { readonly ok: false; readonly errors: readonly ThemeValidationError[] };

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return normalized === '' ? 'theme' : normalized;
}

function installed(id: string, theme: ParsedThemeFile): InstalledTheme {
  const swatchTokens = ['--surface-window', '--surface-panel', '--text-body', '--accent-iris', '--accent-amber', '--accent-green'];
  return {
    id,
    meta: theme.meta,
    warnings: theme.warnings,
    swatches: swatchTokens.flatMap((token) => {
      const value = theme.cssTokens[token as keyof typeof theme.cssTokens];
      return value === undefined ? [] : [value];
    }),
  };
}

function applicable(id: string, theme: ParsedThemeFile): ApplicableTheme {
  return { id, meta: theme.meta, tokens: theme.cssTokens, warnings: theme.warnings };
}

export class ThemeService {
  private readonly previews = new Map<string, PreviewSession>();

  constructor(
    private readonly directory: string,
    private readonly settings: ThemeSettingsStore,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<{ readonly themes: readonly InstalledTheme[]; readonly activeId: string | null }> {
    await mkdir(this.directory, { recursive: true });
    const entries = (await readdir(this.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(THEME_SUFFIX))
      .sort((first, second) => first.name.localeCompare(second.name));
    const themes: InstalledTheme[] = [];
    for (const entry of entries) {
      const id = entry.name.slice(0, -THEME_SUFFIX.length);
      if (!themeIdSchema.safeParse(id).success) continue;
      const result = await this.readStored(id);
      if (result.ok) themes.push(installed(id, result.theme));
    }
    return { themes, activeId: this.settings.get().userTheme };
  }

  async importPath(sourcePath: string): Promise<ThemeImportResult> {
    if (!sourcePath.toLowerCase().endsWith(THEME_SUFFIX)) {
      return { status: 'invalid', errors: [{ path: '$', message: `Theme file must end with ${THEME_SUFFIX}` }] };
    }
    const result = await this.readSource(sourcePath);
    if (!result.ok) return { status: 'invalid', errors: result.errors };
    const id = `${slug(result.theme.meta.name)}-${createHash('sha256').update(result.bytes).digest('hex').slice(0, 12)}`;
    await mkdir(this.directory, { recursive: true });
    const destination = this.pathFor(id);
    const existing = await readFile(destination).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existing !== null) {
      if (!existing.equals(result.bytes)) throw new Error('Theme id collision');
      return { status: 'imported', theme: installed(id, result.theme) };
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, result.bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination).catch(async (error: unknown) => {
      await rm(temporary, { force: true });
      throw error;
    });
    return { status: 'imported', theme: installed(id, result.theme) };
  }

  async active(): Promise<{ readonly theme: ApplicableTheme | null; readonly notice: 'missing' | 'invalid' | null }> {
    const id = this.settings.get().userTheme;
    if (id === null) return { theme: null, notice: null };
    const result = await this.readStored(id);
    if (result.ok) return { theme: applicable(id, result.theme), notice: null };
    this.settings.set({ userTheme: null });
    const missing = result.errors.some((error) => error.message === 'Installed theme file is missing');
    return { theme: null, notice: missing ? 'missing' : 'invalid' };
  }

  async preview(
    id: string,
    senderId: number,
  ): Promise<{ readonly previewId: string; readonly expiresAt: number; readonly theme: ApplicableTheme }> {
    this.cancelForSender(senderId);
    const result = await this.readStored(id);
    if (!result.ok) throw new Error('Theme is unavailable');
    const previewId = randomUUID();
    const expiresAt = this.now() + THEME_PREVIEW_MS;
    const timer = setTimeout(() => this.cancel(previewId, senderId), THEME_PREVIEW_MS);
    timer.unref?.();
    const theme = applicable(id, result.theme);
    this.previews.set(previewId, { id: previewId, senderId, theme, expiresAt, timer, healthy: false });
    return { previewId, expiresAt, theme };
  }

  healthy(previewId: string, senderId: number): boolean {
    const preview = this.livePreview(previewId, senderId);
    if (preview === undefined) return false;
    preview.healthy = true;
    return true;
  }

  confirm(previewId: string, senderId: number): { readonly confirmed: boolean; readonly settings: AppSettings } {
    const preview = this.livePreview(previewId, senderId);
    if (preview === undefined || !preview.healthy) return { confirmed: false, settings: this.settings.get() };
    this.clearPreview(preview);
    return { confirmed: true, settings: this.settings.set({ userTheme: preview.theme.id }) };
  }

  cancel(previewId: string, senderId: number): boolean {
    const preview = this.previews.get(previewId);
    if (preview === undefined || preview.senderId !== senderId) return false;
    this.clearPreview(preview);
    return true;
  }

  cancelForSender(senderId: number): void {
    for (const preview of this.previews.values()) if (preview.senderId === senderId) this.clearPreview(preview);
  }

  async remove(id: string): Promise<{ readonly removed: boolean; readonly settings: AppSettings }> {
    const active = this.settings.get().userTheme === id;
    if (active) this.settings.set({ userTheme: null });
    const removed = await rm(this.pathFor(id)).then(
      () => true,
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      },
    );
    return { removed, settings: this.settings.get() };
  }

  reset(): AppSettings {
    for (const preview of this.previews.values()) this.clearPreview(preview);
    return this.settings.set({ appearance: 'dark', userTheme: null });
  }

  dispose(): void {
    for (const preview of this.previews.values()) this.clearPreview(preview);
  }

  private livePreview(previewId: string, senderId: number): PreviewSession | undefined {
    const preview = this.previews.get(previewId);
    if (preview === undefined || preview.senderId !== senderId) return undefined;
    if (preview.expiresAt <= this.now()) {
      this.clearPreview(preview);
      return undefined;
    }
    return preview;
  }

  private clearPreview(preview: PreviewSession): void {
    clearTimeout(preview.timer);
    this.previews.delete(preview.id);
  }

  private pathFor(id: string): string {
    return path.join(this.directory, `${themeIdSchema.parse(id)}${THEME_SUFFIX}`);
  }

  private async readStored(id: string): Promise<ReadThemeResult> {
    return this.readSource(this.pathFor(id), true);
  }

  private async readSource(sourcePath: string, installedFile = false): Promise<ReadThemeResult> {
    let bytes: Buffer;
    try {
      const info = await stat(sourcePath);
      if (!info.isFile()) return { ok: false, errors: [{ path: '$', message: 'Theme source is not a file' }] };
      if (info.size > MAX_THEME_BYTES) return { ok: false, errors: [{ path: '$', message: 'Theme file exceeds 256 KiB' }] };
      bytes = await readFile(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, errors: [{ path: '$', message: installedFile ? 'Installed theme file is missing' : 'Theme file is missing' }] };
      }
      return { ok: false, errors: [{ path: '$', message: 'Theme file could not be read' }] };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      return { ok: false, errors: [{ path: '$', message: 'Theme file is not valid JSON' }] };
    }
    const result = validateThemeFile(raw);
    return result.ok ? { ok: true, theme: result.theme, bytes } : result;
  }
}
