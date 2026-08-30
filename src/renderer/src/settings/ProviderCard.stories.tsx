import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { ProviderCard, type ProviderCardProps } from './ProviderCard';

// Per-state gallery for the provider connection and native-capacity card.

const base: ProviderCardProps = {
  name: 'iCloud Drive',
  connection: 'connected',
  account: 'm.rivera@icloud.com',
  capacity: { kind: 'none' },
  capabilitiesLine: 'Verify by download · restarts interrupted uploads',
  message: 'Link a provider to store encrypted originals off-device.',
  primaryLabel: 'Disconnect provider',
  primaryVariant: 'secondary',
  primaryDisabled: false,
  onPrimary: fn(),
  onCapacityRoute: fn(),
};

const meta: Meta<typeof ProviderCard> = {
  title: 'Settings/ProviderCard',
  component: ProviderCard,
  args: base,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 560, padding: 'var(--space-6)' }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ProviderCard>;

// iCloud: the honest System Settings capacity route, no fabricated bar.
export const ICloudCapacityRoute: Story = {
  args: { capacity: { kind: 'route' } },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement);
    await expect(card.getByRole('button', { name: /View in System Settings/u })).toBeVisible();
    await expect(card.queryByRole('progressbar')).not.toBeInTheDocument();
  },
};

// Google Drive: account-wide verified capacity from about.storageQuota.
export const GoogleDriveKnownCapacity: Story = {
  args: {
    name: 'Google Drive',
    account: 'm.rivera@gmail.com',
    capacity: { kind: 'known', usedBytes: 42_000_000_000, totalBytes: 2_000_000_000_000 },
    capabilitiesLine: 'Server checksum · resumable uploads',
  },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement);
    await expect(card.getByRole('progressbar')).toBeInTheDocument();
    await expect(card.getByText(/of 2 TB used/u)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Copy provider account' })).toBeVisible();
  },
};

export const PCloudKnownCapacity: Story = {
  args: {
    name: 'pCloud',
    account: 'm.rivera@pcloud.com',
    capacity: { kind: 'known', usedBytes: 380_000_000_000, totalBytes: 500_000_000_000 },
    capabilitiesLine: 'Server checksum · resumable uploads',
  },
};

// A known-quota provider whose quota call failed: no bar and no route.
export const CapacityUnavailable: Story = {
  args: {
    name: 'pCloud',
    account: 'm.rivera@pcloud.com',
    capacity: { kind: 'unavailable' },
  },
};

export const CheckingConnection: Story = {
  args: {
    connection: 'checking',
    account: null,
    primaryLabel: 'Checking…',
    primaryDisabled: true,
  },
};

export const Disconnected: Story = {
  args: {
    connection: 'disconnected',
    account: null,
    primaryLabel: 'Connect iCloud Drive',
    primaryVariant: 'primary',
  },
};

export const StatusUnavailable: Story = {
  args: {
    connection: 'error',
    account: null,
    message: null,
    primaryLabel: 'Try again',
  },
};

// A failed connect surfaces the backend's actionable reason, not generic copy.
export const ConnectError: Story = {
  args: {
    connection: 'error',
    account: null,
    message: 'Google Drive sign-in was cancelled. Try connecting again.',
    primaryLabel: 'Try again',
  },
  play: async ({ canvasElement }) => {
    const card = within(canvasElement);
    await expect(card.getByText('Google Drive sign-in was cancelled. Try connecting again.')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Copy provider error' })).toBeVisible();
  },
};
