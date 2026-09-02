import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { CoverageDialog } from './CoverageDialog';

const photoIds = ['photo-synced', 'photo-trash'];

type Plan = Awaited<ReturnType<typeof window.overlook.coverage.preflight>>;

function installStub(plan: Plan): void {
  (globalThis as { overlook?: unknown }).overlook = {
    coverage: {
      preflight: () => Promise.resolve(plan),
      exclude: () =>
        Promise.resolve({
          excluded: 1,
          removalPending: 0,
          skipped: 1,
          failed: 0,
          results: [
            { photoId: 'photo-synced', outcome: 'excluded', reason: null },
            { photoId: 'photo-trash', outcome: 'skipped', reason: 'deleted' },
          ],
        }),
    },
  };
}

const removal: Plan = {
  tier: 'irreversible',
  eligible: 1,
  ineligible: 1,
  bytes: 8_400_000,
  remoteCopies: 1,
  remoteBytes: 8_400_000,
  downloads: 0,
  sharedRetained: 0,
  provider: 'Local folder',
  account: 'overlook@example.com',
  items: [
    { photoId: 'photo-synced', bytes: 8_400_000, eligible: true, reason: null, remoteCopy: true, download: false, sharedRetained: false },
    { photoId: 'photo-trash', bytes: 0, eligible: false, reason: 'deleted', remoteCopy: false, download: false, sharedRetained: false },
  ],
};

const structural: Plan = {
  ...removal,
  tier: 'structural',
  remoteCopies: 0,
  remoteBytes: 0,
  items: [
    { photoId: 'photo-synced', bytes: 8_400_000, eligible: true, reason: null, remoteCopy: false, download: false, sharedRetained: false },
    { photoId: 'photo-trash', bytes: 0, eligible: false, reason: 'deleted', remoteCopy: false, download: false, sharedRetained: false },
  ],
};

const meta: Meta<typeof CoverageDialog> = {
  title: 'Backup/CoverageDialog',
  component: CoverageDialog,
  args: { photoIds, onClose: fn(), onComplete: fn() },
};

export default meta;
type Story = StoryObj<typeof CoverageDialog>;

// ADR-0023 Tier D: the provider copy goes, so the ceremony names the count,
// bytes, provider and account, and the confirm carries the registry's verb.
export const RemovesCloudCopy: Story = {
  decorators: [
    (Story) => {
      installStub(removal);
      return <Story />;
    },
  ],
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('1 encrypted copy (8.4 MB) will be removed from Local folder (overlook@example.com).'),
    ).toBeVisible();
    await expect(canvas.getByText('1 · in Trash')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove cloud copy permanently' }));
    await expect(args.onComplete).toHaveBeenCalledTimes(1);
  },
};

// Tier M: nothing is destroyed, and the dialog says so instead of warning.
export const KeepsOnThisDevice: Story = {
  decorators: [
    (Story) => {
      installStub(structural);
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Keep on this device only' })).toBeEnabled();
    await expect(canvas.queryByTestId('coverage-remote')).toBeNull();
  },
};
