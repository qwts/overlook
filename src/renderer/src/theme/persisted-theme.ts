import type { AppSettings } from '../../../shared/settings/settings.js';
import type { ApplicableTheme } from '../../../shared/ipc/theme-channels.js';
import type { UserThemeLayer, UserThemeNotice } from './user-theme-layer.js';

export interface PersistedThemeClient {
  active(): Promise<{ theme: ApplicableTheme | null; notice: UserThemeNotice }>;
}

export interface UserThemeSettingsClient {
  get(): Promise<{ settings: Pick<AppSettings, 'userTheme'> }>;
  onChanged(listener: (payload: { settings: Pick<AppSettings, 'userTheme'> }) => void): () => void;
}

export function installPersistedThemeObserver(options: {
  readonly layer: UserThemeLayer;
  readonly themes: PersistedThemeClient;
  readonly settings: UserThemeSettingsClient;
}): () => void {
  let requestedId: string | null | undefined;
  let generation = 0;
  let active = true;

  const load = async (id: string | null): Promise<void> => {
    requestedId = id;
    const request = ++generation;
    if (id === null) {
      options.layer.setPersisted(null);
      return;
    }
    try {
      const result = await options.themes.active();
      if (!active) return;
      if (request !== generation) {
        if (result.notice !== null && requestedId === null) options.layer.setPersisted(null, result.notice);
        return;
      }
      options.layer.setPersisted(result.theme?.id === id ? result.theme : null, result.notice);
    } catch {
      if (active && request === generation) options.layer.setPersisted(null, 'invalid');
    }
  };
  const unsubscribe = options.settings.onChanged(({ settings }) => {
    if (settings.userTheme === requestedId) return;
    void load(settings.userTheme);
  });
  void options.settings.get().then(
    ({ settings }) => {
      if (!active || requestedId !== undefined) return;
      void load(settings.userTheme);
    },
    () => {
      if (active) options.layer.setPersisted(null, 'invalid');
    },
  );

  return () => {
    active = false;
    generation += 1;
    unsubscribe();
  };
}
