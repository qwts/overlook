import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Segmented } from '../components/Segmented';
import { Switch } from '../components/Switch';
import { Field } from './Field';
import { QuickActionsSettings } from './QuickActionsSettings';
import { SHIPPED_LOCALES } from '../../../shared/i18n/locales.js';
import type { AppSettings } from '../../../shared/settings/settings.js';
import { SemanticIndexSettings, semanticIndexHint } from './SemanticIndexSettings';
import { ThemeManager } from './ThemeManager';

// General section (#113): sort order and appearance apply live;
// thumbnails-on-import is locked on with its rationale, matching the schema.

const messages = defineMessages({
  sortOrder: { id: 'settings.general.sortOrder', defaultMessage: 'Default sort order' },
  sortDate: { id: 'settings.general.sort.date', defaultMessage: 'Date' },
  sortName: { id: 'settings.general.sort.name', defaultMessage: 'Name' },
  sortSize: { id: 'settings.general.sort.size', defaultMessage: 'Size' },
  language: { id: 'settings.general.language', defaultMessage: 'Language' },
  languageHint: {
    id: 'settings.general.language.hint',
    defaultMessage: 'Changes apply immediately. System default follows your operating-system language.',
  },
  systemLanguage: { id: 'settings.general.language.system', defaultMessage: 'System default' },
  trashRetention: { id: 'settings.general.trashRetention', defaultMessage: 'Trash retention' },
  trashRetentionHint: {
    id: 'settings.general.trashRetention.hint',
    defaultMessage: 'Controls automatic permanent deletion. You can still delete items manually when automatic deletion is off.',
  },
  trashRetentionOff: { id: 'settings.general.trashRetention.off', defaultMessage: 'Off' },
  trashRetentionDays: { id: 'settings.general.trashRetention.days', defaultMessage: '{days} days' },
  appearance: { id: 'settings.general.appearance', defaultMessage: 'Appearance' },
  quickActions: { id: 'settings.general.quickActions', defaultMessage: 'Quick Actions' },
  quickActionsHint: {
    id: 'settings.general.quickActions.hint',
    defaultMessage: 'Choose and order up to five actions shown while you hold Command over a photo.',
  },
  appearanceHint: {
    id: 'settings.general.appearance.hint',
    defaultMessage: 'Changes apply immediately. System follows your operating-system appearance.',
  },
  dark: { id: 'settings.general.appearance.dark', defaultMessage: 'Dark' },
  light: { id: 'settings.general.appearance.light', defaultMessage: 'Light' },
  systemAppearance: { id: 'settings.general.appearance.system', defaultMessage: 'System' },
  thumbnails: { id: 'settings.general.thumbnails', defaultMessage: 'Generate thumbnails on import' },
  thumbnailsHint: {
    id: 'settings.general.thumbnails.hint',
    defaultMessage: 'The grid browses thumbnails, even offline. Cannot be disabled.',
  },
  semantic: { id: 'settings.general.semantic', defaultMessage: 'On-device semantic index' },
  customThemes: { id: 'settings.general.customThemes', defaultMessage: 'Custom themes' },
  customThemesHint: {
    id: 'settings.general.customThemes.hint',
    defaultMessage: 'Import JSON color themes, inspect contrast warnings, and preview before keeping changes.',
  },
});

export interface GeneralPaneProps {
  readonly settings: AppSettings;
  readonly onPatch: (
    patch: Partial<Pick<AppSettings, 'sortOrder' | 'language' | 'appearance' | 'quickActions' | 'trashRetention'>>,
  ) => void;
}

export function GeneralPane({ settings, onPatch }: GeneralPaneProps): ReactElement {
  const intl = useIntl();
  return (
    <div className="ovl-settings__fields">
      <Field label={intl.formatMessage(messages.sortOrder)}>
        <Segmented
          label={intl.formatMessage(messages.sortOrder)}
          value={settings.sortOrder}
          options={[
            { value: 'date', label: intl.formatMessage(messages.sortDate) },
            { value: 'name', label: intl.formatMessage(messages.sortName) },
            { value: 'size', label: intl.formatMessage(messages.sortSize) },
          ]}
          onChange={(sortOrder) => {
            onPatch({ sortOrder });
          }}
        />
      </Field>
      <Field label={intl.formatMessage(messages.language)} hint={intl.formatMessage(messages.languageHint)}>
        <select
          className="ovl-settings__select"
          aria-label={intl.formatMessage(messages.language)}
          value={settings.language ?? ''}
          onChange={(event) => {
            onPatch({ language: event.target.value === '' ? null : event.target.value });
          }}
        >
          <option value="">{intl.formatMessage(messages.systemLanguage)}</option>
          {SHIPPED_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {intl.formatDisplayName(locale, { type: 'language' }) ?? locale}
            </option>
          ))}
        </select>
      </Field>
      <Field label={intl.formatMessage(messages.trashRetention)} hint={intl.formatMessage(messages.trashRetentionHint)}>
        <Segmented
          label={intl.formatMessage(messages.trashRetention)}
          value={settings.trashRetention}
          options={[
            { value: 'off', label: intl.formatMessage(messages.trashRetentionOff) },
            { value: '7', label: intl.formatMessage(messages.trashRetentionDays, { days: 7 }) },
            { value: '30', label: intl.formatMessage(messages.trashRetentionDays, { days: 30 }) },
            { value: '90', label: intl.formatMessage(messages.trashRetentionDays, { days: 90 }) },
          ]}
          onChange={(trashRetention) => {
            onPatch({ trashRetention });
          }}
        />
      </Field>
      <Field label={intl.formatMessage(messages.appearance)} hint={intl.formatMessage(messages.appearanceHint)}>
        <Segmented
          label={intl.formatMessage(messages.appearance)}
          value={settings.appearance}
          options={[
            { value: 'dark', label: intl.formatMessage(messages.dark) },
            { value: 'light', label: intl.formatMessage(messages.light) },
            { value: 'system', label: intl.formatMessage(messages.systemAppearance) },
          ]}
          onChange={(appearance) => {
            onPatch({ appearance });
          }}
        />
      </Field>
      <Field wide label={intl.formatMessage(messages.customThemes)} hint={intl.formatMessage(messages.customThemesHint)}>
        <ThemeManager />
      </Field>
      <Field wide label={intl.formatMessage(messages.quickActions)} hint={intl.formatMessage(messages.quickActionsHint)}>
        <QuickActionsSettings
          value={settings.quickActions}
          onChange={(quickActions) => {
            onPatch({ quickActions: [...quickActions] });
          }}
        />
      </Field>
      <Field label={intl.formatMessage(messages.thumbnails)} hint={intl.formatMessage(messages.thumbnailsHint)}>
        <Switch checked disabled accessibleLabel={intl.formatMessage(messages.thumbnails)} />
      </Field>
      <Field wide label={intl.formatMessage(messages.semantic)} hint={intl.formatMessage(semanticIndexHint)}>
        <SemanticIndexSettings />
      </Field>
    </div>
  );
}
