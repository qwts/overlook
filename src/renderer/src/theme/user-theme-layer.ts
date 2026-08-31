import type { ApplicableTheme } from '../../../shared/ipc/theme-channels.js';
import { THEME_TOKENS } from '../../../shared/theme/theme-file.js';

export interface ConstructedSheet {
  replaceSync(css: string): void;
}

export interface UserThemeLayerHost {
  readonly root: { readonly dataset: { theme?: string }; readonly style: { colorScheme: string } };
  createSheet(): ConstructedSheet;
  adoptedSheets(): readonly ConstructedSheet[];
  adopt(sheets: readonly ConstructedSheet[]): void;
}

export type UserThemeNotice = 'missing' | 'invalid' | null;

const allowedTokens = new Set<string>(THEME_TOKENS);

export function themeCss(theme: ApplicableTheme): string {
  const declarations = Object.entries(theme.tokens)
    .filter(([token]) => allowedTokens.has(token))
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([token, value]) => `${token}:${value}`)
    .join(';');
  return `@media (forced-colors: none){:root:not([data-contrast='more']){${declarations}}}`;
}

export class UserThemeLayer {
  private sheet: ConstructedSheet | null = null;
  private persisted: ApplicableTheme | null = null;
  private pendingPreview: ApplicableTheme | null = null;
  private currentNotice: UserThemeNotice = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: UserThemeLayerHost) {}

  base(): 'dark' | 'light' | null {
    return (this.pendingPreview ?? this.persisted)?.meta.base ?? null;
  }

  activeId(): string | null {
    return (this.pendingPreview ?? this.persisted)?.id ?? null;
  }

  notice(): UserThemeNotice {
    return this.currentNotice;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPersisted(theme: ApplicableTheme | null, notice: UserThemeNotice = null): void {
    this.persisted = theme;
    this.pendingPreview = null;
    this.currentNotice = notice;
    this.render();
  }

  preview(theme: ApplicableTheme): void {
    this.pendingPreview = theme;
    this.render();
  }

  commitPreview(): void {
    if (this.pendingPreview !== null) this.persisted = this.pendingPreview;
    this.pendingPreview = null;
    this.render();
  }

  cancelPreview(): void {
    this.pendingPreview = null;
    this.render();
  }

  reset(): void {
    this.pendingPreview = null;
    this.persisted = null;
    this.currentNotice = null;
    this.render();
  }

  private render(): void {
    const theme = this.pendingPreview ?? this.persisted;
    const withoutPrior = this.host.adoptedSheets().filter((sheet) => sheet !== this.sheet);
    if (theme === null) {
      this.sheet = null;
      this.host.adopt(withoutPrior);
    } else {
      const next = this.host.createSheet();
      next.replaceSync(themeCss(theme));
      this.sheet = next;
      this.host.adopt([...withoutPrior, next]);
      this.host.root.dataset.theme = theme.meta.base;
      this.host.root.style.colorScheme = theme.meta.base;
    }
    for (const listener of this.listeners) listener();
  }
}

let applicationLayer: UserThemeLayer | undefined;

export function installApplicationThemeLayer(layer: UserThemeLayer): void {
  applicationLayer = layer;
}

export function getApplicationThemeLayer(): UserThemeLayer {
  if (applicationLayer === undefined) throw new Error('User theme layer is not installed');
  return applicationLayer;
}
