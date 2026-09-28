import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { TitlebarHelpMenu } from './TitlebarMenu';

// A plausible titlebar slot so the affordance sits where it ships — a no-drag
// island at the right edge, left of where the window controls would be.
function Frame({ children }: { readonly children: ReactElement }): ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', height: 'var(--titlebar-h)', background: 'var(--gray-0)' }}>{children}</div>
  );
}

const meta: Meta<typeof TitlebarHelpMenu> = {
  title: 'Core/TitlebarHelpMenu',
  component: TitlebarHelpMenu,
  args: { onCommand: fn() },
  decorators: [
    (Story) => (
      <Frame>
        <Story />
      </Frame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof TitlebarHelpMenu>;

// Windows: the quiet Help button at rest, left of the (mocked) window controls.
export const Windows: Story = {
  args: { platform: 'win32' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const help = canvas.getByRole('button', { name: 'Help' });
    await expect(help).toHaveAttribute('aria-haspopup', 'menu');
    await expect(help).toHaveAttribute('aria-expanded', 'false');
  },
};

// Opening surfaces the full macOS Help menu, in order, focus on the first item;
// the separator adds no focus stop; selecting dispatches its registry command id
// and closes the menu with focus restored to the button.
export const WindowsOpen: Story = {
  args: { platform: 'win32' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const help = canvas.getByRole('button', { name: 'Help' });
    await userEvent.click(help);
    await expect(help).toHaveAttribute('aria-expanded', 'true');

    const items = canvas.getAllByRole('menuitem');
    await expect(items.map((item) => item.textContent)).toEqual([
      'Keyboard shortcuts?',
      'Activity…',
      'Privacy & Diagnostics',
      'Overlook Help',
    ]);
    // Focus lands on the first item, never left on the button while open.
    await expect(items[0]).toHaveFocus();
    // Roving wraps; the separator before Privacy is not a focus stop.
    await userEvent.keyboard('{ArrowDown}');
    await expect(items[1]).toHaveFocus();

    await userEvent.click(canvas.getByRole('menuitem', { name: /Activity/u }));
    await expect(args.onCommand).toHaveBeenCalledWith('help.activity');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(help).toHaveAttribute('aria-expanded', 'false');
    await expect(help).toHaveFocus();
  },
};

// ↓ opens on the first item; ↑/End opens on the last (APG menu-button pattern).
export const KeyboardOpensLast: Story = {
  args: { platform: 'win32' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const help = canvas.getByRole('button', { name: 'Help' });
    help.focus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    const items = canvas.getAllByRole('menuitem');
    await expect(items[items.length - 1]).toHaveFocus();
  },
};

// Every item dispatches the same registry id its macOS Help-menu counterpart
// does (parity, I1), across successive opens.
export const EachItemDispatches: Story = {
  args: { platform: 'win32' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const help = canvas.getByRole('button', { name: 'Help' });
    const cases: readonly [RegExp, string][] = [
      [/Keyboard shortcuts/u, 'help.shortcuts'],
      [/Activity/u, 'help.activity'],
      [/Privacy & Diagnostics/u, 'app.settings.open.privacy'],
      [/Overlook Help/u, 'help.open'],
    ];
    for (const [name, command] of cases) {
      await userEvent.click(help);
      await userEvent.click(canvas.getByRole('menuitem', { name }));
      await expect(args.onCommand).toHaveBeenLastCalledWith(command);
    }
  },
};

// Esc closes without acting; focus returns to the button (never dropped to body).
export const EscapeRestoresFocus: Story = {
  args: { platform: 'win32' },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const help = canvas.getByRole('button', { name: 'Help' });
    await userEvent.click(help);
    await expect(canvas.getByRole('menu')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(help).toHaveFocus();
    await expect(args.onCommand).not.toHaveBeenCalled();
  },
};

export const Linux: Story = {
  args: { platform: 'linux' },
};

// RTL (en-XB pseudo-locale): the titlebar mirrors — button and popover move to
// the left; the ContextMenu clamps into the viewport on that edge.
export const Rtl: Story = {
  args: { platform: 'win32' },
  globals: { locale: 'en-XB' },
};

// prefers-reduced-motion drops the button tint transition and the popover's
// show/hide animation — state stays carried by aria-expanded + the pressed tint.
export const ReducedMotion: Story = {
  args: { platform: 'linux' },
  parameters: { chromatic: { prefersReducedMotion: 'reduce' } },
};

// Layout holds at 200% text: the button keeps its slot, the popover widens.
export const LargeText: Story = {
  args: { platform: 'win32' },
  decorators: [
    (Story) => (
      <div style={{ fontSize: '200%' }}>
        <Story />
      </div>
    ),
  ],
};

// macOS keeps its native Help menu, so the titlebar affordance is not drawn.
export const MacAbsent: Story = {
  args: { platform: 'darwin' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Help' })).toBeNull();
  },
};
