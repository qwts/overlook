import type { Meta, StoryObj } from '@storybook/react-vite';
import { IntlProvider } from 'react-intl';
import { expect, userEvent, within } from 'storybook/test';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { ApplicableTheme, InstalledTheme } from '../../../shared/ipc/theme-channels.js';
import { defaultSettings } from '../../../shared/settings/settings.js';
import { documentThemeLayer } from '../theme/document-theme-layer';
import { installApplicationThemeLayer } from '../theme/user-theme-layer';
import { ThemeManager } from './ThemeManager';
import './settings.css';

const warning = {
  kind: 'contrast' as const,
  foreground: '--text-muted',
  background: '--surface-window',
  ratio: 3.2,
  message: '--text-muted / --surface-window contrast is 3.2:1; AA guidance is 4.5:1',
};
const installed: InstalledTheme = {
  id: 'northern-lights-0123456789ab',
  meta: { name: 'Northern lights', author: 'Overlook', version: '1.0.0', base: 'dark', tokensVersion: 1 },
  warnings: [warning],
  swatches: ['rgb(5% 6% 10%)', 'rgb(53% 47% 100%)', 'rgb(95% 95% 98%)'],
};
const applicable: ApplicableTheme = {
  id: installed.id,
  meta: installed.meta,
  warnings: installed.warnings,
  tokens: {
    '--surface-window': 'rgb(5% 6% 10%)',
    '--accent-iris': 'rgb(37% 25% 75%)',
    '--text-on-accent': 'rgb(100% 100% 100%)',
  },
};

function installStub(): void {
  const layer = documentThemeLayer(document);
  installApplicationThemeLayer(layer);
  const themes: OverlookApi['themes'] = {
    list: () => Promise.resolve({ themes: [installed], activeId: null }),
    pickImport: () => Promise.resolve({ status: 'cancelled' }),
    importPath: () => Promise.resolve({ status: 'cancelled' }),
    exportTemplate: ({ tokens }) => Promise.resolve({ status: 'exported', tokenCount: Object.keys(tokens).length, warnings: [warning] }),
    active: () => Promise.resolve({ theme: null, notice: null }),
    preview: () => Promise.resolve({ previewId: crypto.randomUUID(), expiresAt: Date.now() + 15_000, theme: applicable }),
    previewHealthy: () => Promise.resolve({ accepted: true }),
    confirm: () => Promise.resolve({ confirmed: true, settings: { ...defaultSettings, userTheme: installed.id } }),
    cancel: () => Promise.resolve({ cancelled: true }),
    remove: () => Promise.resolve({ removed: true, settings: defaultSettings }),
    reset: () => Promise.resolve({ settings: defaultSettings }),
  };
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = {
    themes,
    import: { pathForFile: () => '' } as unknown as OverlookApi['import'],
  };
}

const meta = {
  title: 'Settings/ThemeManager',
  component: ThemeManager,
  decorators: [
    (Story) => {
      installStub();
      return (
        <IntlProvider locale="en">
          <div className="ovl-settings__fieldControl">
            <Story />
          </div>
        </IntlProvider>
      );
    },
  ],
} satisfies Meta<typeof ThemeManager>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InstalledWithWarning: Story = {};

export const ExportTemplate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Export theme template' }));
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(/Exported a template with \d+ tokens and 1 contrast warning\./);
  },
};

export const PreviewConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Preview' }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.findByRole('dialog', { name: 'Keep this theme?' })).resolves.toBeTruthy();
    await expect(body.findByText(/AA guidance is 4.5:1/)).resolves.toBeTruthy();
  },
};
