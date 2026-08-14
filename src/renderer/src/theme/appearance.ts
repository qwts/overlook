import type { AppSettings } from '../../../shared/settings/settings.js';

type Appearance = AppSettings['appearance'];
type ResolvedAppearance = Exclude<Appearance, 'system'>;

export interface AppearanceMediaQuery {
  readonly matches: boolean;
  addEventListener(event: 'change', listener: () => void): void;
  removeEventListener(event: 'change', listener: () => void): void;
}

export interface AppearanceRoot {
  readonly dataset: { theme?: string; contrast?: string };
  readonly style: { colorScheme: string };
}

export interface AppearanceSettingsClient {
  get(): Promise<{ settings: Pick<AppSettings, 'appearance'> }>;
  onChanged(listener: (payload: { settings: Pick<AppSettings, 'appearance'> }) => void): () => void;
}

export function resolveAppearance(appearance: Appearance, prefersDark: boolean): ResolvedAppearance {
  return appearance === 'system' ? (prefersDark ? 'dark' : 'light') : appearance;
}

export function installAppearanceObserver(options: {
  readonly root: AppearanceRoot;
  readonly media: AppearanceMediaQuery;
  readonly contrastMedia: AppearanceMediaQuery;
  readonly settings: AppearanceSettingsClient;
}): () => void {
  const bootTheme = options.root.dataset.theme;
  let appearance: Appearance = bootTheme === 'dark' || bootTheme === 'light' ? bootTheme : 'system';
  let changed = false;
  let active = true;

  const apply = (): void => {
    const resolved = resolveAppearance(appearance, options.media.matches);
    options.root.dataset.theme = resolved;
    options.root.style.colorScheme = resolved;
  };
  const onMediaChanged = (): void => {
    if (appearance === 'system') apply();
  };
  const applyContrast = (): void => {
    if (options.contrastMedia.matches) options.root.dataset.contrast = 'more';
    else delete options.root.dataset.contrast;
  };
  const unsubscribe = options.settings.onChanged(({ settings }) => {
    changed = true;
    appearance = settings.appearance;
    apply();
  });

  options.media.addEventListener('change', onMediaChanged);
  options.contrastMedia.addEventListener('change', applyContrast);
  apply();
  applyContrast();
  void options.settings.get().then(({ settings }) => {
    if (!active || changed) return;
    appearance = settings.appearance;
    apply();
  });

  return () => {
    active = false;
    unsubscribe();
    options.media.removeEventListener('change', onMediaChanged);
    options.contrastMedia.removeEventListener('change', applyContrast);
  };
}
