import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { ViewMode } from '../../../shared/library/app-state.js';
import { AppStateProvider, useAppDispatch } from '../state/app-state-context';
import { Toolbar } from './Toolbar';

// #1290 (Pass B spec §02): the toolbar stays one 48px row and collapses in a
// fixed order — zoom → wordmark text → Import label → view control. Each
// story frames the toolbar at a window width from the spec, with Back up and
// Lock showing so the row carries its widest content.

interface FrameProps {
  readonly width: number;
  readonly view?: ViewMode;
}

function installStub(): void {
  const library = { onPendingCountChanged: () => () => undefined } as unknown as OverlookApi['library'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { library };
}

function Scenario({ view }: { readonly view: ViewMode }) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch({ type: 'providerConnected/set', connected: true });
    dispatch({ type: 'pendingCount/set', count: 3 });
    dispatch({ type: 'view/set', view });
  }, [dispatch, view]);
  return <Toolbar platform="darwin" onImport={() => undefined} onLock={() => undefined} />;
}

function ToolbarFrame({ width, view = 'grid' }: FrameProps) {
  return (
    <AppStateProvider>
      <div data-testid="toolbar-frame" style={{ inlineSize: width }}>
        <Scenario view={view} />
      </div>
    </AppStateProvider>
  );
}

const meta: Meta<typeof ToolbarFrame> = {
  title: 'App/Toolbar/Collapse',
  component: ToolbarFrame,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof ToolbarFrame>;

function toolbarRow(canvasElement: HTMLElement): HTMLElement {
  const row = canvasElement.querySelector<HTMLElement>('.ovl-toolbar__row');
  if (row === null) throw new Error('toolbar row not rendered');
  return row;
}

async function frameSettled(): Promise<void> {
  // One frame for the ResizeObserver, one for the render it triggers.
  // Requesting frames also keeps a headless browser rendering, so the
  // observer fires at all.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function setFrameWidth(canvasElement: HTMLElement, width: number): Promise<void> {
  within(canvasElement).getByTestId('toolbar-frame').style.inlineSize = `${width}px`;
  await frameSettled();
}

async function expectOneRow(row: HTMLElement): Promise<void> {
  await expect(row.getBoundingClientRect().height).toBe(48);
  await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
}

async function expectLevel(row: HTMLElement, level: number): Promise<void> {
  await waitFor(async () => {
    await expect(row).toHaveAttribute('data-collapse', String(level));
  });
  await expectOneRow(row);
}

// The names every level keeps (spec §06): Import is "Import" at every level.
async function expectNames(canvasElement: HTMLElement, level: number): Promise<void> {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('button', { name: 'Import' })).toBeVisible();
  if (level >= 1) await expect(canvas.getByRole('button', { name: 'Zoom' })).toBeVisible();
  else await expect(canvas.getByRole('slider', { name: 'Zoom' })).toBeVisible();
  if (level >= 4) await expect(canvas.getByRole('button', { name: 'View: Grid' })).toBeVisible();
  else await expect(canvas.getByRole('radiogroup', { name: 'View' })).toBeVisible();
  await expect(canvas.queryByRole('toolbar')).not.toBeInTheDocument();
}

function levelStory(width: number, level: number): Story {
  return {
    args: { width },
    play: async ({ canvasElement }) => {
      await expectLevel(toolbarRow(canvasElement), level);
      await expectNames(canvasElement, level);
    },
  };
}

// One story per level. The spec's pixel thresholds are English reference
// values; with Back up and Lock showing, this build steps at about 1066,
// 936, 764, and 700px, so each story sits inside its level's band.

/** Level 0, the default window: everything shows. */
export const Level0At1280 = levelStory(1280, 0);
/** Level 1: the zoom slider becomes the Zoom button. */
export const Level1At1040 = levelStory(1040, 1);
/** Level 2: the wordmark text hides; the mark stays. */
export const Level2At900 = levelStory(900, 2);
/** Level 3: Import goes icon-only, still primary. */
export const Level3At720 = levelStory(720, 3);
/** Level 4 (the 960 minimum window at 200%): the view control is a menu. */
export const Level4At480 = levelStory(480, 4);

// Level ≥1 in Grid view: the Zoom popover moves the zoom level, and Esc
// closes it back to the Zoom button.
export const ZoomPopover: Story = {
  args: { width: 1040 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = within(canvasElement.ownerDocument.body);
    await expectLevel(toolbarRow(canvasElement), 1);
    const zoom = canvas.getByRole('button', { name: 'Zoom' });
    await expect(zoom).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(zoom);
    const popover = doc.getByRole('dialog', { name: 'Zoom' });
    const slider = within(popover).getByRole('slider', { name: 'Zoom' });
    await expect(slider).toHaveFocus();
    // Native range inputs only step on trusted key events; drive the change.
    await fireEvent.change(slider, { target: { value: '200' } });
    await expect(slider).toHaveValue('200');
    await waitFor(async () => {
      await expect(slider).toHaveFocus();
    });
    await userEvent.keyboard('{Escape}');
    await expect(doc.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(zoom).toHaveFocus();
  },
};

// Level 4: choosing List from the View menu updates the button's glyph and
// name, announces it, and hides Zoom.
export const ViewMenu: Story = {
  args: { width: 480 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = within(canvasElement.ownerDocument.body);
    await expectLevel(toolbarRow(canvasElement), 4);
    const trigger = canvas.getByRole('button', { name: 'View: Grid' });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(trigger);
    const menu = doc.getByRole('menu', { name: 'View' });
    await expect(within(menu).getByRole('menuitemradio', { name: 'Grid' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(doc.queryByRole('menu')).not.toBeInTheDocument();
    const listTrigger = canvas.getByRole('button', { name: 'View: List' });
    await expect(listTrigger).toHaveFocus();
    await expect(listTrigger.querySelector('.lucide-list')).not.toBeNull();
    await waitFor(async () => {
      await expect(doc.getByTestId('screen-reader-announcer-polite')).toHaveTextContent('View: List.');
    });
    // Zoom keeps its place but hides outside Grid view.
    await expect(canvasElement.querySelector('.ovl-toolbar__zoom-button')).not.toBeVisible();
  },
};

// A focused control that collapses hands focus to its replacement, and back
// again — never to <body>. An open popover whose owner collapses closes.
export const FocusFollowsCollapse: Story = {
  args: { width: 1280 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = within(canvasElement.ownerDocument.body);
    const row = toolbarRow(canvasElement);
    await expectLevel(row, 0);

    canvas.getByRole('slider', { name: 'Zoom' }).focus();
    await setFrameWidth(canvasElement, 1040);
    await expectLevel(row, 1);
    await expect(canvas.getByRole('button', { name: 'Zoom' })).toHaveFocus();

    await userEvent.click(canvas.getByRole('button', { name: 'Zoom' }));
    await expect(doc.getByRole('slider', { name: 'Zoom' })).toHaveFocus();
    await setFrameWidth(canvasElement, 1280);
    await expectLevel(row, 0);
    await expect(doc.queryByRole('dialog')).not.toBeInTheDocument();
    await expect(canvas.getByRole('slider', { name: 'Zoom' })).toHaveFocus();

    canvas.getByRole('radio', { name: 'Grid' }).focus();
    await setFrameWidth(canvasElement, 480);
    await expectLevel(row, 4);
    await expect(canvas.getByRole('button', { name: 'View: Grid' })).toHaveFocus();
    await setFrameWidth(canvasElement, 1280);
    await expectLevel(row, 0);
    await expect(canvas.getByRole('radio', { name: 'Grid' })).toHaveFocus();
  },
};

// Sweep 1440 → 480 → 1440 in 40px steps: one 48px row throughout, levels
// only ever move in the sweep's direction, and the controls keep their order.
// Holding within ±8px of a step doesn't flicker.
export const ResizeSweep: Story = {
  args: { width: 1440 },
  play: async ({ canvasElement }) => {
    const row = toolbarRow(canvasElement);
    await expectLevel(row, 0);
    const order = (): string =>
      Array.from(row.querySelectorAll<HTMLElement>('button, input'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.getAttribute('aria-label') ?? element.getAttribute('role') ?? element.tagName)
        .join(' · ');
    const widths = Array.from({ length: 25 }, (_, index) => 1440 - index * 40);
    let previous = 0;
    let stepUpAt: number | null = null;
    for (const width of widths) {
      await setFrameWidth(canvasElement, width);
      const level = Number(row.dataset['collapse']);
      await expect(level).toBeGreaterThanOrEqual(previous);
      if (level > previous && stepUpAt === null && level < 4) stepUpAt = width;
      previous = level;
      await expectOneRow(row);
    }
    await expect(previous).toBe(4);
    const collapsedOrder = order();
    for (const width of [...widths].reverse()) {
      await setFrameWidth(canvasElement, width);
      const level = Number(row.dataset['collapse']);
      await expect(level).toBeLessThanOrEqual(previous);
      previous = level;
      await expectOneRow(row);
    }
    await expect(previous).toBe(0);
    await expect(collapsedOrder).toContain('Search mode: Auto · Search library · Filters');

    // Find the first step to the pixel, then hold within ±8px of it.
    if (stepUpAt === null) throw new Error('no collapse step in the sweep');
    let width = stepUpAt + 40;
    await setFrameWidth(canvasElement, width);
    const above = row.dataset['collapse'];
    while (row.dataset['collapse'] === above && width > stepUpAt) {
      width -= 1;
      await setFrameWidth(canvasElement, width);
    }
    const held = row.dataset['collapse'];
    await expect(held).not.toBe(above);
    for (const hold of [width + 8, width - 8, width + 8, width - 8]) {
      await setFrameWidth(canvasElement, hold);
      await expect(row.dataset['collapse']).toBe(held);
    }
  },
};

// Left open for review and the axe pass (every theme): the level-4 View menu
// and the level-1 Zoom popover.
export const ViewMenuOpen: Story = {
  args: { width: 480 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expectLevel(toolbarRow(canvasElement), 4);
    await userEvent.click(canvas.getByRole('button', { name: 'View: Grid' }));
    await expect(within(canvasElement.ownerDocument.body).getByRole('menuitemradio', { name: 'Grid' })).toHaveFocus();
  },
};

export const ZoomPopoverOpen: Story = {
  args: { width: 1040 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expectLevel(toolbarRow(canvasElement), 1);
    await userEvent.click(canvas.getByRole('button', { name: 'Zoom' }));
    await expect(within(canvasElement.ownerDocument.body).getByRole('slider', { name: 'Zoom' })).toHaveFocus();
  },
};
