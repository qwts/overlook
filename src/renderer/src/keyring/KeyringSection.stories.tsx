import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { KeyringSection } from './KeyringSection';
import type { KeyringEntry } from './keyring-entry.js';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import { destructiveActions } from '../../../shared/destructive-actions.js';

// #517 exit criteria: the registry lists every key with its custody facts,
// the write key and KEY #1 cannot be removed, a retired key that still
// seals photos goes through the Tier D ceremony (counts + acknowledgment +
// the "permanently" label), and an absent key reads as locked. The stub
// stands in for the keyring IPC — the real crypto round-trips in the unit
// and E2E lanes.

const KEYS: readonly KeyringEntry[] = [
  {
    id: 1,
    keyRef: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    version: 1,
    kind: 'library',
    origin: 'local',
    label: null,
    fingerprint: '9F2C·4A81·D0E7·5B3A',
    createdAt: '2026-07-01T00:00:00.000Z',
    present: true,
    active: false,
    databaseKey: true,
    usage: { photos: 0, sidecars: 0, bytes: 0 },
  },
  {
    id: 2,
    keyRef: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    version: 1,
    kind: 'library',
    origin: 'local',
    label: null,
    fingerprint: '7C0A·11F4·9B2E·D6A3',
    createdAt: '2026-07-02T00:00:00.000Z',
    present: true,
    active: false,
    databaseKey: false,
    usage: { photos: 2, sidecars: 1, bytes: 812_000 },
  },
  {
    id: 3,
    keyRef: 'ffeeddccbbaa99887766554433221100',
    version: 1,
    kind: 'library',
    origin: 'local',
    label: null,
    fingerprint: '12AB·34CD·56EF·7890',
    createdAt: '2026-07-03T00:00:00.000Z',
    present: true,
    active: true,
    databaseKey: false,
    usage: { photos: 46, sidecars: 0, bytes: 40_120_000 },
  },
  {
    id: 4,
    keyRef: '00112233445566778899aabbccddeeff',
    version: 1,
    kind: 'library',
    origin: 'imported',
    label: 'Studio laptop',
    fingerprint: 'AB12·CD34·EF56·0978',
    createdAt: '2026-07-04T00:00:00.000Z',
    present: false,
    active: false,
    databaseKey: false,
    usage: { photos: 3, sidecars: 0, bytes: 2_400_000 },
  },
];

function installStub(): void {
  const keyring: OverlookApi['keyring'] = {
    list: () => Promise.resolve({ keys: KEYS }),
    export: () => Promise.resolve({ path: '/Users/ansel/Desktop/overlook-key-a1b2c3d4-v1.key' }),
    pickFile: () => Promise.resolve({ path: '/Users/ansel/Desktop/overlook-key-a1b2c3d4-v1.key' }),
    import: () => Promise.resolve({ outcome: 'imported', keyId: 4, fingerprint: 'AB12·CD34·EF56·0978', unlocked: 3, reason: null }),
    removePreflight: ({ id }) => {
      const entry = KEYS.find((key) => key.id === id) ?? null;
      const usage = entry?.usage ?? { photos: 0, sidecars: 0, bytes: 0 };
      return Promise.resolve({
        allowed: entry !== null && entry.present && !entry.databaseKey && !entry.active,
        reason:
          entry === null
            ? 'not-found'
            : entry.databaseKey
              ? 'database-key'
              : entry.active
                ? 'write-key'
                : entry.present
                  ? null
                  : 'not-present',
        tier: usage.photos + usage.sidecars > 0 ? 'irreversible' : 'structural',
        usage,
        entry,
      });
    },
    remove: ({ id }) => Promise.resolve({ removed: true, reason: null, locked: KEYS.find((key) => key.id === id)?.usage.photos ?? 0 }),
    setLabel: () => Promise.resolve({}),
  };
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { keyring };
}

const meta: Meta<typeof KeyringSection> = {
  title: 'App/KeyringSection',
  component: KeyringSection,
  decorators: [
    (Story) => {
      installStub();
      return (
        <div style={{ width: 640 }}>
          <Story />
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof KeyringSection>;

export const Registry: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(async () => {
      await expect(canvas.getByTestId('keyring-row-4')).toBeVisible();
    });
    await expect(canvas.getByTestId('keyring-row-1')).toHaveTextContent('Database');
    await expect(canvas.getByTestId('keyring-row-3')).toHaveTextContent('Write key');
    await expect(canvas.getByTestId('keyring-row-4')).toHaveTextContent('Not on this device');
    await expect(canvas.getByTestId('keyring-row-4')).toHaveTextContent('Studio laptop');
    // KEY #1, the write key and an absent key cannot be removed; an absent key cannot be exported.
    await expect(canvas.getByTestId('keyring-remove-1')).toBeDisabled();
    await expect(canvas.getByTestId('keyring-remove-3')).toBeDisabled();
    await expect(canvas.getByTestId('keyring-remove-4')).toBeDisabled();
    await expect(canvas.getByTestId('keyring-export-4')).toBeDisabled();
    await expect(canvas.getByTestId('keyring-remove-2')).toBeEnabled();
  },
};

export const RemoveCeremony: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(canvas.getByTestId('keyring-remove-2')).toBeEnabled();
    });
    await userEvent.click(canvas.getByTestId('keyring-remove-2'));
    await expect(body.getByRole('dialog', { name: destructiveActions.removeEncryptionKey.title })).toBeVisible();
    await waitFor(async () => {
      await expect(body.getByTestId('keyring-remove-counts')).toHaveTextContent('2');
    });
    const confirm = body.getByRole('button', { name: destructiveActions.removeEncryptionKey.label });
    await expect(confirm).toBeDisabled();
    await userEvent.click(body.getByRole('checkbox'));
    await expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(async () => {
      await expect(body.getByTestId('keyring-done')).toHaveTextContent('KEY #2 removed · 2 photos locked');
    });
  },
};

export const ImportCeremony: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByTestId('keyring-import'));
    const importButton = body.getByTestId('keyring-dialog-import');
    await expect(importButton).toBeDisabled();
    await userEvent.click(body.getByTestId('keyring-choose-file'));
    await userEvent.type(body.getByLabelText('Password'), 'correct horse');
    await expect(importButton).toBeEnabled();
    await userEvent.click(importButton);
    await waitFor(async () => {
      await expect(body.getByTestId('keyring-done')).toHaveTextContent('KEY #4 imported · 3 photos unlocked');
    });
  },
};
