import type { AppSettings } from '../shared/settings/settings.js';

export type ResolvedAppearance = 'dark' | 'light';

export const WINDOW_BACKGROUND: Readonly<Record<ResolvedAppearance, string>> = {
  dark: '#050708',
  light: '#f7f8fa',
};
export const HIGH_CONTRAST_WINDOW_BACKGROUND: Readonly<Record<ResolvedAppearance, string>> = {
  dark: '#000000',
  light: '#ffffff',
};

export function withAppearanceBootstrapQuery(url: string, appearance: ResolvedAppearance): string {
  const next = new URL(url);
  next.searchParams.set('theme', appearance);
  return next.toString();
}

export interface AppearanceSettingsSource {
  get(): Pick<AppSettings, 'appearance'>;
  subscribe(listener: (settings: Pick<AppSettings, 'appearance'>) => void): () => void;
}

export interface NativeThemeSource {
  themeSource: AppSettings['appearance'];
  readonly shouldUseDarkColors: boolean;
  readonly shouldUseHighContrastColors: boolean;
  on(event: 'updated', listener: () => void): void;
  off(event: 'updated', listener: () => void): void;
}

export interface AppearanceRuntime {
  dispose(): void;
}

export function createAppearanceRuntime(options: {
  readonly settings: AppearanceSettingsSource;
  readonly nativeTheme: NativeThemeSource;
  readonly apply: (appearance: ResolvedAppearance, backgroundColor: string) => void;
}): AppearanceRuntime {
  const applyResolved = (): void => {
    const appearance = options.nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    const backgrounds = options.nativeTheme.shouldUseHighContrastColors ? HIGH_CONTRAST_WINDOW_BACKGROUND : WINDOW_BACKGROUND;
    options.apply(appearance, backgrounds[appearance]);
  };
  const applySetting = ({ appearance }: Pick<AppSettings, 'appearance'>): void => {
    options.nativeTheme.themeSource = appearance;
    applyResolved();
  };

  const unsubscribe = options.settings.subscribe(applySetting);
  options.nativeTheme.on('updated', applyResolved);
  applySetting(options.settings.get());

  return {
    dispose() {
      unsubscribe();
      options.nativeTheme.off('updated', applyResolved);
    },
  };
}
