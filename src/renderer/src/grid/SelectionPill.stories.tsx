import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { SelectionPill } from './SelectionPill';
import type { AlbumSummary } from '../../../shared/library/types.js';

// The picker (#118) reads albums over the bridge — a two-album stub with a
// working inline create. Only the two calls the picker makes are stubbed,
// so the global slot is typed unknown rather than faking a full OverlookApi.
function installStub(): void {
  // The picker lists albums only — folders never hold photos (#505) — so the
  // stub names each row's kind the way the bridge does.
  const albums: (AlbumSummary & { readonly kind: 'album' })[] = [
    { id: 'A1', name: 'Big Sur', count: 10, kind: 'album' },
    { id: 'A2', name: 'Kyoto', count: 4, kind: 'album' },
  ];
  (globalThis as { overlook?: unknown }).overlook = {
    library: { albums: () => Promise.resolve({ albums }) },
    albums: {
      create: ({ name }: { name: string }) => {
        const album = { id: `A${String(albums.length + 1)}`, name, count: 0, kind: 'album' as const };
        albums.push(album);
        return Promise.resolve({ album });
      },
    },
  };
}

const meta: Meta<typeof SelectionPill> = {
  title: 'Grid/SelectionPill',
  component: SelectionPill,
  decorators: [
    (Story) => {
      installStub();
      return (
        <div style={{ position: 'relative', height: 320, display: 'flex', alignItems: 'flex-end' }}>
          <Story />
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof SelectionPill>;

const onClear = fn();

// #78 exit criteria: counts render with thousands separators; Export (#100),
// Move to Trash (#120), and Add to album (#118) are live; clear-× works.
export const ThousandsSeparatorAndClear: Story = {
  args: { count: 12_345, onClear, onDelete: fn(), onAddToAlbum: fn(), onOffload: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('12,345 selected')).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /Export/ })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: /Add to album/ })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: /Offload/ }));
    await expect(args.onOffload).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Move to Trash' }));
    await expect(args.onDelete).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Clear selection' }));
    await expect(onClear).toHaveBeenCalledTimes(1);
  },
};

export const SingleSelection: Story = {
  args: { count: 1, onClear: fn() },
};

export const MixedOriginalSelection: Story = {
  args: { count: 3, onClear: fn(), onMarkOriginal: fn(), onUnmarkOriginal: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Everything fits at this width, so Mark sits inline and there is no ⋯.
    await userEvent.click(await canvas.findByRole('button', { name: 'Mark as Original' }));
    await expect(args.onMarkOriginal).toHaveBeenCalledOnce();
    await expect(canvas.queryByRole('button', { name: 'More selection actions' })).toBeNull();
  },
};

export const ActiveAlbumMode: Story = {
  args: { count: 3, onClear: fn(), onDelete: fn(), onAddToAlbum: fn(), onRemoveFromAlbum: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Move to Trash' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove from album' }));
    await expect(args.onRemoveFromAlbum).toHaveBeenCalledTimes(1);
  },
};

// Trash mode (#120/#121): Restore is the headline; permanent deletion opens
// the purge ceremony; Export leaves.
export const TrashRestoreMode: Story = {
  args: { count: 2, onClear: fn(), onRestore: fn(), onPurge: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: /Export/ })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Restore from Trash' }));
    await expect(args.onRestore).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete permanently…' }));
    await expect(args.onPurge).toHaveBeenCalledTimes(1);
  },
};

// Add-to-album picker (#118): albums with live counts, pick fires with the
// album, Escape closes, inline create picks the new album.
export const AlbumPickerFlow: Story = {
  args: { count: 12, onClear: fn(), onDelete: fn(), onAddToAlbum: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /Add to album/ }));
    // Focus moves INTO the picker on open (PR #219 review) — keyboard users
    // land on the first album row, not back on the trigger.
    await waitFor(() => expect(canvas.getByRole('menuitem', { name: /Big Sur/ })).toHaveFocus());
    await userEvent.click(canvas.getByRole('menuitem', { name: /Big Sur/ }));
    await expect(args.onAddToAlbum).toHaveBeenCalledWith({ id: 'A1', name: 'Big Sur', count: 10, kind: 'album' });
    await expect(canvas.queryByTestId('album-picker')).toBeNull();

    // Inline create picks the fresh album.
    await userEvent.click(canvas.getByRole('button', { name: /Add to album/ }));
    await userEvent.type(await canvas.findByLabelText('New album name'), 'Yosemite{Enter}');
    await waitFor(() => expect(args.onAddToAlbum).toHaveBeenCalledWith({ id: 'A3', name: 'Yosemite', count: 0, kind: 'album' }));

    // Escape closes without picking.
    await userEvent.click(canvas.getByRole('button', { name: /Add to album/ }));
    await waitFor(() => expect(canvas.getByTestId('album-picker')).toBeVisible());
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByTestId('album-picker')).toBeNull();
  },
};

export const LockedSelection: Story = {
  args: {
    count: 1,
    onClear: fn(),
    onExport: fn(),
    onMarkOriginal: fn(),
    exportDisabledReason: 'The selected photos need keys that are not on this device.',
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // Unavailable, not disabled: it stays focusable and names its reason.
    const exportButton = canvas.getByRole('button', { name: 'Export…' });
    await expect(exportButton).toHaveAttribute('aria-disabled', 'true');
    await expect(exportButton).toBeEnabled();
    await expect(exportButton).not.toHaveAttribute('title');
    await expect(exportButton).toHaveAccessibleDescription('The selected photos need keys that are not on this device.');
    await userEvent.click(exportButton);
    await expect(args.onExport).not.toHaveBeenCalled();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    // Focus shows the reason visually; it's described once, by the reason span,
    // so the bubble is hidden from assistive tech (#1304).
    await waitFor(() => expect(document.querySelector('.ovl-tooltip__bubble')).toHaveTextContent('keys that are not on this device'));
    await expect(document.querySelector('.ovl-tooltip__bubble')).toHaveAttribute('aria-hidden', 'true');
    await expect(exportButton).toHaveAccessibleDescription('The selected photos need keys that are not on this device.');
    await expect(canvas.getByRole('button', { name: 'Add to album' })).toBeEnabled();
  },
};

export const FailedCustodyLookup: Story = {
  args: {
    count: 1,
    onClear: fn(),
    onExport: fn(),
    onRetryExport: fn(),
    exportDisabledReason: 'Could not verify photo keys. Try again.',
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const retry = canvas.getByRole('button', { name: 'Retry photo keys' });
    await expect(retry).toBeEnabled();
    await expect(retry).toHaveAccessibleDescription('Could not verify photo keys. Try again.');
    await userEvent.click(retry);
    await expect(args.onRetryExport).toHaveBeenCalledOnce();
    await expect(args.onExport).not.toHaveBeenCalled();
  },
};

// ---- Collapse (#1304, Pass E spec) -----------------------------------------
// The pill measures its content area (the anchor), so each story sets that
// area's width. Level n moves the n lowest-priority actions into ⋯.

const LIBRARY_ARGS = {
  count: 24,
  onClear: fn(),
  onExport: fn(),
  onOffload: fn(),
  onTransfer: fn(),
  onAddToAlbum: fn(),
  onMarkOriginal: fn(),
  onDelete: fn(),
};
const ALBUM_ARGS = { ...LIBRARY_ARGS, onRemoveFromAlbum: fn() };
const TRASH_ARGS = { count: 24, onClear: fn(), onRestore: fn(), onPurge: fn() };

const LIBRARY_ACTIONS = ['Offload', 'Transfer & Sync', 'Export…', 'Add to album', 'Mark as Original', 'Move to Trash'];
const ALBUM_ACTIONS = ['Offload', 'Transfer & Sync', 'Export…', 'Add to album', 'Mark as Original', 'Remove from album'];
const TRASH_ACTIONS = ['Restore from Trash', 'Delete permanently…'];

function atWidth(width: number, dir: 'ltr' | 'rtl' = 'ltr'): NonNullable<Story['decorators']> {
  return [
    (Story) => (
      <div dir={dir} data-testid="pill-width" style={{ position: 'relative', width, height: 320 }}>
        <Story />
      </div>
    ),
  ];
}

function isShown(element: Element): boolean {
  return element.getClientRects().length > 0;
}

function labelOf(element: Element): string {
  return element.querySelector('span')?.firstChild?.textContent ?? element.textContent ?? '';
}

// Every action lives in exactly one place, ⋯ shows only when it holds
// something, and the pill stays on one line inside its gutter.
async function expectOneHomeEach(canvasElement: HTMLElement, all: readonly string[]): Promise<void> {
  const canvas = within(canvasElement);
  const pill = canvas.getByTestId('selection-pill');
  const inline = Array.from(pill.querySelectorAll('.ovl-pill__action button'))
    .filter(isShown)
    .map((button) => button.textContent ?? '');
  await expect(pill.scrollWidth).toBeLessThanOrEqual(pill.clientWidth);
  await expect(pill.getBoundingClientRect().height).toBeLessThan(48);
  const more = canvas.queryByRole('button', { name: 'More selection actions' });
  if (inline.length === all.length) {
    await expect(more).toBeNull();
    return;
  }
  await expect(more).not.toBeNull();
  if (more === null) return;
  await userEvent.click(more);
  const menu = await within(document.body).findByRole('menu', { name: 'Selection actions' });
  const overflow = within(menu).getAllByRole('menuitem').map(labelOf);
  await expect(overflow.filter((name) => inline.includes(name))).toEqual([]);
  await expect([...inline, ...overflow].sort()).toEqual([...all].sort());
  // ⋯ keeps inline order.
  await expect(overflow).toEqual(all.filter((name) => overflow.includes(name)));
  await userEvent.keyboard('{Escape}');
  await expect(more).toHaveFocus();
}

function matrixStory(width: number, args: NonNullable<Story['args']>, all: readonly string[]): Story {
  return {
    args,
    decorators: atWidth(width),
    play: async ({ canvasElement }) => {
      await expectOneHomeEach(canvasElement, all);
    },
  };
}

export const Library1100 = matrixStory(1100, LIBRARY_ARGS, LIBRARY_ACTIONS);
export const Library760 = matrixStory(760, LIBRARY_ARGS, LIBRARY_ACTIONS);
export const Library560 = matrixStory(560, LIBRARY_ARGS, LIBRARY_ACTIONS);
export const Library420 = matrixStory(420, LIBRARY_ARGS, LIBRARY_ACTIONS);
export const Library300 = matrixStory(300, LIBRARY_ARGS, LIBRARY_ACTIONS);
export const Album1100 = matrixStory(1100, ALBUM_ARGS, ALBUM_ACTIONS);
export const Album760 = matrixStory(760, ALBUM_ARGS, ALBUM_ACTIONS);
export const Album560 = matrixStory(560, ALBUM_ARGS, ALBUM_ACTIONS);
export const Album420 = matrixStory(420, ALBUM_ARGS, ALBUM_ACTIONS);
export const Album300 = matrixStory(300, ALBUM_ARGS, ALBUM_ACTIONS);
export const Trash1100 = matrixStory(1100, TRASH_ARGS, TRASH_ACTIONS);
export const Trash760 = matrixStory(760, TRASH_ARGS, TRASH_ACTIONS);
export const Trash560 = matrixStory(560, TRASH_ARGS, TRASH_ACTIONS);
export const Trash420 = matrixStory(420, TRASH_ARGS, TRASH_ACTIONS);
export const Trash300 = matrixStory(300, TRASH_ARGS, TRASH_ACTIONS);

const nextFrames = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

// Shrinking 1100 → 300 moves exactly one action per step, lowest priority
// first (Transfer, Mark, Offload, Add, Trash, Export); growing back reverses.
export const CollapseSweep: Story = {
  args: LIBRARY_ARGS,
  decorators: atWidth(1100),
  play: async ({ canvasElement }) => {
    const area = within(canvasElement).getByTestId('pill-width');
    const pill = within(canvasElement).getByTestId('selection-pill');
    const hiddenOrder: string[] = [];
    const seen = (): string[] =>
      Array.from(pill.querySelectorAll('.ovl-pill__action button'))
        .filter((button) => !isShown(button))
        .map((button) => button.textContent ?? '');
    let level = Number(pill.dataset['collapse']);
    for (let width = 1100; width >= 300; width -= 20) {
      area.style.width = `${String(width)}px`;
      await nextFrames();
      const next = Number(pill.dataset['collapse']);
      await expect(next - level).toBeGreaterThanOrEqual(0);
      await expect(next - level).toBeLessThanOrEqual(1);
      for (const name of seen()) if (!hiddenOrder.includes(name)) hiddenOrder.push(name);
      level = next;
    }
    await expect(hiddenOrder).toEqual(
      ['Transfer & Sync', 'Mark as Original', 'Offload', 'Add to album', 'Move to Trash', 'Export…'].slice(0, level),
    );
    for (let width = 300; width <= 1100; width += 20) {
      area.style.width = `${String(width)}px`;
      await nextFrames();
      const next = Number(pill.dataset['collapse']);
      await expect(level - next).toBeGreaterThanOrEqual(0);
      await expect(level - next).toBeLessThanOrEqual(1);
      level = next;
    }
    await expect(level).toBe(0);
  },
};

// Keyboard: ↓ opens on the first enabled item, arrows reach unavailable
// items, Tab and Esc return to ⋯, and Add to album returns there too.
export const MenuOpen: Story = {
  args: { ...LIBRARY_ARGS, exportDisabledReason: 'The selected photos need keys that are not on this device.' },
  // Narrow enough that Export, the last to leave, is in ⋯ too.
  decorators: atWidth(220),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    const more = canvas.getByRole('button', { name: 'More selection actions' });
    more.focus();
    await userEvent.keyboard('{ArrowDown}');
    const menu = await body.findByRole('menu', { name: 'Selection actions' });
    const items = within(menu).getAllByRole('menuitem');
    await expect(items[0]).toHaveFocus();
    const exportItem = within(menu).getByRole('menuitem', { name: 'Export…' });
    await expect(exportItem).toHaveAttribute('aria-disabled', 'true');
    await expect(exportItem).toHaveAccessibleDescription('The selected photos need keys that are not on this device.');
    await expect(within(menu).getByText('The selected photos need keys that are not on this device.')).toBeVisible();
    await userEvent.keyboard('{End}');
    await expect(items.at(-1)).toHaveFocus();
    await expect(items.at(-1)).toHaveAccessibleName('Move to Trash');
    for (let index = 0; index < items.length; index += 1) await userEvent.keyboard('{ArrowUp}');
    await expect(items.at(-1)).toHaveFocus();
    await userEvent.click(exportItem);
    await expect(args.onExport).not.toHaveBeenCalled();
    await userEvent.tab();
    await expect(body.queryByRole('menu')).toBeNull();
    await expect(more).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await body.findByRole('menuitem', { name: 'Add to album' }));
    await waitFor(() => expect(canvas.getByRole('menuitem', { name: /Big Sur/ })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByTestId('album-picker')).toBeNull();
    await expect(more).toHaveFocus();
  },
};

// A focused action that collapses hands focus to ⋯; ⋯ leaving hands it to
// the last inline action; an open menu closes when the level changes.
export const FocusHandoff: Story = {
  args: LIBRARY_ARGS,
  decorators: atWidth(1100),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const area = canvas.getByTestId('pill-width');
    canvas.getByRole('button', { name: 'Transfer & Sync' }).focus();
    area.style.width = '800px';
    await waitFor(() => expect(canvas.getByRole('button', { name: 'More selection actions' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await within(document.body).findByRole('menu', { name: 'Selection actions' });
    area.style.width = '560px';
    await waitFor(() => expect(within(document.body).queryByRole('menu')).toBeNull());
    await expect(canvas.getByRole('button', { name: 'More selection actions' })).toHaveFocus();
    area.style.width = '1100px';
    await waitFor(() => expect(canvas.queryByRole('button', { name: 'More selection actions' })).toBeNull());
    await expect(canvas.getByRole('button', { name: 'Move to Trash' })).toHaveFocus();
  },
};

export const RightToLeft: Story = {
  args: LIBRARY_ARGS,
  decorators: atWidth(560, 'rtl'),
  play: async ({ canvasElement }) => {
    await expectOneHomeEach(canvasElement, LIBRARY_ACTIONS);
    const more = within(canvasElement).getByRole('button', { name: 'More selection actions' });
    await userEvent.click(more);
    const menu = await within(document.body).findByRole('menu', { name: 'Selection actions' });
    // In RTL the menu hangs from ⋯'s inline end, which is its left edge.
    await expect(Math.abs(menu.getBoundingClientRect().left - more.getBoundingClientRect().left)).toBeLessThanOrEqual(2);
    await userEvent.keyboard('{Escape}');
  },
};
