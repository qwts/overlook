import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ShortcutHelp } from './ShortcutHelp';
import type { CommandPlatform } from '../../../shared/commands/registry.js';

const meta: Meta<typeof ShortcutHelp> = {
  title: 'Commands/ShortcutHelp',
  component: ShortcutHelp,
};

export default meta;
type Story = StoryObj<typeof ShortcutHelp>;

function GridHelp({ platform }: { readonly platform: CommandPlatform }): ReactElement | null {
  const [open, setOpen] = useState(true);
  return open ? (
    <ShortcutHelp
      context={{ surface: 'grid', dialogOpen: false, editable: false, platform }}
      platform={platform}
      onClose={() => setOpen(false)}
    />
  ) : null;
}

export const GeneratedForGridContext: Story = {
  render: () => <GridHelp platform="darwin" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await expect(canvas.getByText('Select all photos')).toBeInTheDocument();
    await expect(canvas.getByText('⌘A')).toBeInTheDocument();
    await expect(canvas.queryByText('Next photo')).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
  },
};

export const GeneratedForWindows: Story = {
  render: () => <GridHelp platform="win32" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Ctrl+A')).toBeInTheDocument();
    await expect(canvas.getByText('Ctrl+K')).toBeInTheDocument();
    await expect(canvas.queryByText('⌘A')).not.toBeInTheDocument();
  },
};
