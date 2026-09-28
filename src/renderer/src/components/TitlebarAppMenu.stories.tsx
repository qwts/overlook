import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { EMPTY_COMMAND_MENU_CONTEXT, type CommandMenuContext } from '../../../shared/commands/menu-contract.js';
import { TitlebarAppMenu, TitlebarHelpMenu } from './TitlebarMenu';

// #1293 (Pass B spec §04): the Windows/Linux ⋯ Overlook menu, left of Help.

const grid: CommandMenuContext = {
  ...EMPTY_COMMAND_MENU_CONTEXT,
  surface: 'grid',
  hasLibrary: true,
  hasPhotos: true,
  hasPhotoKeyTarget: true,
  appLockConfigured: true,
  pcloudEnabled: true,
};

// A plausible titlebar slot: ⋯ then Help at the right edge, where they ship.
function Frame({ children }: { readonly children: ReactElement }): ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', height: 'var(--titlebar-h)', background: 'var(--gray-0)' }}>
      {children}
      <TitlebarHelpMenu platform="win32" onCommand={() => undefined} />
    </div>
  );
}

const meta: Meta<typeof TitlebarAppMenu> = {
  title: 'Core/TitlebarAppMenu',
  component: TitlebarAppMenu,
  args: { platform: 'win32', context: grid, onCommand: fn() },
  decorators: [
    (Story) => (
      <Frame>
        <Story />
      </Frame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof TitlebarAppMenu>;

export const Windows: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Overlook menu' });
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button.getBoundingClientRect().width).toBe(44);
    await expect(button.getBoundingClientRect().height).toBe(30);
  },
};

// Open, for review: four labelled groups with visible headings, shortcuts the
// renderer resolves exposed as aria-keyshortcuts, focus on the first item.
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Overlook menu' }));
    const menu = canvas.getByRole('menu', { name: 'Overlook menu' });
    const groups = within(menu).getAllByRole('group');
    await expect(groups.map((group) => group.getAttribute('aria-labelledby') !== null)).toEqual([true, true, true, true]);
    await expect(within(menu).getByRole('group', { name: 'File' })).toBeVisible();
    await expect(within(menu).getByRole('group', { name: 'Overlook' })).toBeVisible();
    await expect(within(menu).getAllByRole('separator')).toHaveLength(3);
    const importItem = within(menu).getByRole('menuitem', { name: 'Import Photos…' });
    await expect(importItem).toHaveFocus();
    await expect(within(menu).getByRole('menuitem', { name: 'Undo' })).toHaveAttribute('aria-keyshortcuts', 'Control+z');
    // Import's ⌘I is a macOS menu accelerator only, so no key is advertised here.
    await expect(importItem).not.toHaveAttribute('aria-keyshortcuts');
    // Headings and separators add no focus stops.
    await userEvent.keyboard('{End}');
    await expect(within(menu).getByRole('menuitem', { name: 'Lock Now' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(importItem).toHaveFocus();
  },
};

// A protected album is open: Export All stays, focusable and disabled, and
// its reason is read as the item's description.
export const WithDisabledItem: Story = {
  args: { context: { ...grid, protectedAlbumOpen: true } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Overlook menu' }));
    const exportAll = canvas.getByRole('menuitem', { name: 'Export All Unencrypted…' });
    await expect(exportAll).toHaveAttribute('aria-disabled', 'true');
    await expect(exportAll).toHaveAccessibleDescription('Not available while a protected album is open');
    await userEvent.keyboard('{ArrowDown}');
    await expect(exportAll).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onCommand).not.toHaveBeenCalled();
    await expect(canvas.getByRole('menu')).toBeVisible();
  },
};

// Choosing Settings… closes the menu and returns focus to ⋯ before the
// command runs, so the dialog it opens hands focus back to ⋯ on close.
export const ChooseSettings: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole('button', { name: 'Overlook menu' });
    await userEvent.click(button);
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Settings…' }));
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(button).toHaveFocus();
    await expect(args.onCommand).toHaveBeenCalledWith('app.settings.open');
  },
};

// pCloud off and no app lock: Transfer & Sync and Lock Now have no place here.
export const WithoutPcloudOrLock: Story = {
  args: { context: { ...grid, pcloudEnabled: false, appLockConfigured: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Overlook menu' }));
    await expect(canvas.queryByRole('menuitem', { name: 'Transfer & Sync' })).toBeNull();
    await expect(canvas.queryByRole('menuitem', { name: 'Lock Now' })).toBeNull();
    await expect(canvas.getByRole('menuitem', { name: 'Storage & Backup' })).toBeVisible();
  },
};

// RTL (en-XB pseudo-locale): the titlebar mirrors and the menu clamps into
// the viewport on the near edge.
export const Rtl: Story = {
  globals: { locale: 'en-XB' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getAllByRole('button')[0] as HTMLElement);
    await expect(within(canvasElement).getByRole('menu')).toBeVisible();
  },
};

// macOS keeps its native menu bar, so ⋯ is not drawn.
export const MacAbsent: Story = {
  args: { platform: 'darwin' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button', { name: 'Overlook menu' })).toBeNull();
  },
};
