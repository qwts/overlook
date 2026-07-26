import { z } from 'zod';
import { providerIdSchema } from '../backup/provider-descriptor.js';
import { llmProviderIdSchema } from '../llm/provider.js';
import { isQuickActionCommandId, type QuickActionCommandId } from '../commands/registry.js';
import { DEFAULT_TRASH_RETENTION, trashRetentionSchema } from '../library/trash.js';

export const CURRENT_DIAGNOSTICS_CONSENT_VERSION = 1 as const;

export const DEFAULT_QUICK_ACTIONS: readonly QuickActionCommandId[] = [
  'photo.favorite.toggle',
  'album.membership.add',
  'photo.export',
  'photo.trash',
];

const quickActionIdSchema = z.custom<QuickActionCommandId>(
  (value) => typeof value === 'string' && isQuickActionCommandId(value),
  'Unknown Quick Action command',
);

export const quickActionsSchema = z
  .array(quickActionIdSchema)
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length, 'Quick Action commands must be unique');

// Typed app settings (#111, epic #44): one source of truth for every knob
// the SettingsDialog surfaces (design SettingsDialog.jsx = the control
// inventory). The schema is the contract — main persists it, the renderer
// renders it, and the backup engine reads throttle/Wi-Fi/auto-backup live.

export const settingsSchema = z.object({
  sortOrder: z.enum(['date', 'name', 'size']),
  /** Explicit UI language; null follows the operating-system locale. */
  language: z.string().min(1).nullable(),
  /** First-party theme, or the live operating-system preference. */
  appearance: z.enum(['dark', 'light', 'system']),
  /** Ordered Command-hover actions. Empty disables the overlay. */
  quickActions: quickActionsSchema,
  /** Locked true by design: imports always generate thumbnails. */
  thumbnailsOnImport: z.literal(true),
  autoBackupOnImport: z.boolean(),
  /** Keep cloud-only originals temporary after viewing unless the user
   * explicitly chooses permanent local custody. */
  reOffloadAfterViewing: z.boolean(),
  importMode: z.enum(['copy', 'move']),
  wifiOnly: z.boolean(),
  /** Percent of available upload, 10–100; 100 = unlimited. */
  bandwidthLimit: z.number().int().min(10).max(100),
  /** Library-scoped automatic Trash purge window; off keeps manual purge. */
  trashRetention: trashRetentionSchema,
  shareDiagnostics: z.boolean(),
  /** Versioned because consent to the old local-only placeholder cannot
   * silently become consent to a future network recipient. */
  diagnosticsConsentVersion: z.union([z.literal(0), z.literal(CURRENT_DIAGNOSTICS_CONSENT_VERSION)]),
  appLockIdle: z.enum(['1', '5', '15', '30', 'never']),
  lockWhenHidden: z.boolean(),
  /** Connected provider; null = disconnected (backup controls disable). */
  providerId: providerIdSchema.nullable(),
  /** Selected cloud LLM provider (ADR-0018 §7); null = none selected. The API
   * key itself never lives here — it is in OS custody under userData/llm-auth. */
  llmProviderId: llmProviderIdSchema.nullable(),
  /** Per-feature opt-in for ask-about-this-photo (ADR-0018 §7). Default off:
   * a fresh install makes zero LLM network calls. */
  llmQaEnabled: z.boolean(),
  /** Explicit opt-in for the one-time local embedding-model download. The
   * model cache is profile-scoped; derived vectors remain per-library. */
  semanticSearchEnabled: z.boolean(),
});

/** The settings:set request shape — every key optional, same rules. */
export const settingsPatchSchema = settingsSchema.omit({ diagnosticsConsentVersion: true }).partial().strict();

export type AppSettings = z.output<typeof settingsSchema>;
export type SettingsPatch = z.output<typeof settingsPatchSchema>;

/** ADR-0017 §6: these preferences follow the app profile, not a library. */
export const profileSettingsSchema = settingsSchema.pick({
  appearance: true,
  language: true,
  quickActions: true,
  shareDiagnostics: true,
  diagnosticsConsentVersion: true,
  llmProviderId: true,
  llmQaEnabled: true,
  semanticSearchEnabled: true,
});

/** ADR-0017 §6: these policies belong to exactly one library directory. */
export const librarySettingsSchema = settingsSchema.omit({
  appearance: true,
  language: true,
  quickActions: true,
  shareDiagnostics: true,
  diagnosticsConsentVersion: true,
  llmProviderId: true,
  llmQaEnabled: true,
  semanticSearchEnabled: true,
});

export type ProfileSettings = z.output<typeof profileSettingsSchema>;
export type LibrarySettings = z.output<typeof librarySettingsSchema>;

export const defaultSettings: AppSettings = {
  sortOrder: 'date',
  language: null,
  appearance: 'dark',
  quickActions: [...DEFAULT_QUICK_ACTIONS],
  thumbnailsOnImport: true,
  autoBackupOnImport: true,
  reOffloadAfterViewing: true,
  importMode: 'copy',
  wifiOnly: true,
  bandwidthLimit: 100,
  trashRetention: DEFAULT_TRASH_RETENTION,
  shareDiagnostics: false,
  diagnosticsConsentVersion: 0,
  appLockIdle: '5',
  lockWhenHidden: false,
  providerId: 'mock',
  llmProviderId: null,
  llmQaEnabled: false,
  semanticSearchEnabled: false,
};

export const defaultProfileSettings: ProfileSettings = {
  appearance: defaultSettings.appearance,
  language: defaultSettings.language,
  quickActions: defaultSettings.quickActions,
  shareDiagnostics: defaultSettings.shareDiagnostics,
  diagnosticsConsentVersion: defaultSettings.diagnosticsConsentVersion,
  llmProviderId: defaultSettings.llmProviderId,
  llmQaEnabled: defaultSettings.llmQaEnabled,
  semanticSearchEnabled: defaultSettings.semanticSearchEnabled,
};

export const defaultLibrarySettings: LibrarySettings = {
  sortOrder: defaultSettings.sortOrder,
  thumbnailsOnImport: defaultSettings.thumbnailsOnImport,
  autoBackupOnImport: defaultSettings.autoBackupOnImport,
  reOffloadAfterViewing: defaultSettings.reOffloadAfterViewing,
  importMode: defaultSettings.importMode,
  wifiOnly: defaultSettings.wifiOnly,
  bandwidthLimit: defaultSettings.bandwidthLimit,
  trashRetention: defaultSettings.trashRetention,
  appLockIdle: defaultSettings.appLockIdle,
  lockWhenHidden: defaultSettings.lockWhenHidden,
  providerId: defaultSettings.providerId,
};

const profileRecoverySchema = z
  .object({
    appearance: settingsSchema.shape.appearance.catch(defaultProfileSettings.appearance),
    language: settingsSchema.shape.language.catch(defaultProfileSettings.language),
    quickActions: settingsSchema.shape.quickActions.catch([...defaultProfileSettings.quickActions]),
    shareDiagnostics: settingsSchema.shape.shareDiagnostics.catch(defaultProfileSettings.shareDiagnostics),
    diagnosticsConsentVersion: settingsSchema.shape.diagnosticsConsentVersion.catch(0),
    llmProviderId: settingsSchema.shape.llmProviderId.catch(defaultProfileSettings.llmProviderId),
    llmQaEnabled: settingsSchema.shape.llmQaEnabled.catch(defaultProfileSettings.llmQaEnabled),
    semanticSearchEnabled: settingsSchema.shape.semanticSearchEnabled.catch(defaultProfileSettings.semanticSearchEnabled),
  })
  .catch(defaultProfileSettings);

const libraryRecoverySchema = z
  .object({
    sortOrder: settingsSchema.shape.sortOrder.catch(defaultLibrarySettings.sortOrder),
    thumbnailsOnImport: settingsSchema.shape.thumbnailsOnImport.catch(true),
    autoBackupOnImport: settingsSchema.shape.autoBackupOnImport.catch(defaultLibrarySettings.autoBackupOnImport),
    reOffloadAfterViewing: settingsSchema.shape.reOffloadAfterViewing.catch(defaultLibrarySettings.reOffloadAfterViewing),
    importMode: settingsSchema.shape.importMode.catch(defaultLibrarySettings.importMode),
    wifiOnly: settingsSchema.shape.wifiOnly.catch(defaultLibrarySettings.wifiOnly),
    bandwidthLimit: settingsSchema.shape.bandwidthLimit.catch(defaultLibrarySettings.bandwidthLimit),
    trashRetention: settingsSchema.shape.trashRetention.catch(defaultLibrarySettings.trashRetention),
    appLockIdle: settingsSchema.shape.appLockIdle.catch(defaultLibrarySettings.appLockIdle),
    lockWhenHidden: settingsSchema.shape.lockWhenHidden.catch(defaultLibrarySettings.lockWhenHidden),
    providerId: settingsSchema.shape.providerId.catch(defaultLibrarySettings.providerId),
  })
  .catch(defaultLibrarySettings);

export function recoverProfileSettings(raw: unknown): ProfileSettings {
  const recovered = profileRecoverySchema.parse(raw);
  if (!recovered.shareDiagnostics || recovered.diagnosticsConsentVersion !== CURRENT_DIAGNOSTICS_CONSENT_VERSION) {
    return { ...recovered, shareDiagnostics: false, diagnosticsConsentVersion: 0 };
  }
  return recovered;
}

export function recoverLibrarySettings(raw: unknown): LibrarySettings {
  return libraryRecoverySchema.parse(raw);
}

export function profileSettingsOf(settings: AppSettings): ProfileSettings {
  return {
    appearance: settings.appearance,
    language: settings.language,
    quickActions: settings.quickActions,
    shareDiagnostics: settings.shareDiagnostics,
    diagnosticsConsentVersion: settings.diagnosticsConsentVersion,
    llmProviderId: settings.llmProviderId,
    llmQaEnabled: settings.llmQaEnabled,
    semanticSearchEnabled: settings.semanticSearchEnabled,
  };
}

export function librarySettingsOf(settings: AppSettings): LibrarySettings {
  return {
    sortOrder: settings.sortOrder,
    thumbnailsOnImport: settings.thumbnailsOnImport,
    autoBackupOnImport: settings.autoBackupOnImport,
    reOffloadAfterViewing: settings.reOffloadAfterViewing,
    importMode: settings.importMode,
    wifiOnly: settings.wifiOnly,
    bandwidthLimit: settings.bandwidthLimit,
    trashRetention: settings.trashRetention,
    appLockIdle: settings.appLockIdle,
    lockWhenHidden: settings.lockWhenHidden,
    providerId: settings.providerId,
  };
}

export function combineSettings(profile: ProfileSettings, library: LibrarySettings): AppSettings {
  return { ...library, ...profile };
}

const librarySettingKeys = new Set(Object.keys(defaultLibrarySettings));

export function hasLegacyLibrarySettings(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && Object.keys(raw).some((key) => librarySettingKeys.has(key));
}

export function patchTouchesLibrary(patch: SettingsPatch): boolean {
  return Object.keys(patch).some((key) => librarySettingKeys.has(key));
}

export function patchTouchesProfile(patch: SettingsPatch): boolean {
  return Object.keys(patch).some((key) => !librarySettingKeys.has(key));
}

/** The backup engine's throttle view of the slider: 100 = unlimited. */
export function throttlePercentOf(settings: AppSettings): number | null {
  return settings.bandwidthLimit >= 100 ? null : settings.bandwidthLimit;
}

// Explicit per-key merge: `undefined` in a patch means "unchanged", while
// providerId's real `null` (disconnected) must win — so no spread, no ??
// on the nullable key. The locked key stays literal.
export function mergeSettings(current: AppSettings, patch: SettingsPatch): AppSettings {
  const shareDiagnostics = patch.shareDiagnostics ?? current.shareDiagnostics;
  return {
    sortOrder: patch.sortOrder ?? current.sortOrder,
    language: patch.language !== undefined ? patch.language : current.language,
    appearance: patch.appearance ?? current.appearance,
    quickActions: patch.quickActions ?? current.quickActions,
    thumbnailsOnImport: true,
    autoBackupOnImport: patch.autoBackupOnImport ?? current.autoBackupOnImport,
    reOffloadAfterViewing: patch.reOffloadAfterViewing ?? current.reOffloadAfterViewing,
    importMode: patch.importMode ?? current.importMode,
    wifiOnly: patch.wifiOnly ?? current.wifiOnly,
    bandwidthLimit: patch.bandwidthLimit ?? current.bandwidthLimit,
    trashRetention: patch.trashRetention ?? current.trashRetention,
    shareDiagnostics,
    diagnosticsConsentVersion:
      patch.shareDiagnostics === true
        ? CURRENT_DIAGNOSTICS_CONSENT_VERSION
        : patch.shareDiagnostics === false
          ? 0
          : current.diagnosticsConsentVersion,
    appLockIdle: patch.appLockIdle ?? current.appLockIdle,
    lockWhenHidden: patch.lockWhenHidden ?? current.lockWhenHidden,
    providerId: patch.providerId !== undefined ? patch.providerId : current.providerId,
    llmProviderId: patch.llmProviderId !== undefined ? patch.llmProviderId : current.llmProviderId,
    llmQaEnabled: patch.llmQaEnabled ?? current.llmQaEnabled,
    semanticSearchEnabled: patch.semanticSearchEnabled ?? current.semanticSearchEnabled,
  };
}
