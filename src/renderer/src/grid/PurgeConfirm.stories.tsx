import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { PurgeConfirm } from './PurgeConfirm';

const meta: Meta<typeof PurgeConfirm> = {
  title: 'Grid/PurgeConfirm',
  component: PurgeConfirm,
};

export default meta;
type Story = StoryObj<typeof PurgeConfirm>;

export const ExactIrreversibleCeremony: Story = {
  args: { count: 2, onCancel: fn(), onConfirm: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const dialog = canvas.getByRole('dialog', { name: 'Delete 2 photos permanently?' });
    await expect(dialog).toHaveTextContent('recoverable only through the provider');
    await expect(dialog).toHaveTextContent('Cloud deletion failures are recorded and retried');
    await expect(dialog).toHaveTextContent('This cannot be undone.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await expect(args.onConfirm).toHaveBeenCalledOnce();
  },
};

export const PendingCloudRemoval: Story = {
  args: { count: 1, excludingCount: 1, onCancel: fn(), onConfirm: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('purge-excluding')).toHaveTextContent('1 photo may still have a cloud copy: removal is pending.');
    await expect(canvas.queryByTestId('purge-excluded')).not.toBeInTheDocument();
  },
};

export const MixedCoverage: Story = {
  args: { count: 3, excludingCount: 1, excludedCount: 1, onCancel: fn(), onConfirm: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('purge-excluding')).toHaveTextContent('1 photo may still have a cloud copy');
    await expect(canvas.getByTestId('purge-excluded')).toHaveTextContent(
      '1 of these is kept on this device only and has no cloud copy to remove.',
    );
  },
};

export const SettledExclusion: Story = {
  args: { count: 1, excludedCount: 1, onCancel: fn(), onConfirm: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('purge-excluded')).toHaveTextContent('there is no cloud copy to remove.');
    await expect(canvas.queryByTestId('purge-excluding')).not.toBeInTheDocument();
  },
};
