import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { CommandPlatform } from '../../../shared/commands/registry.js';
import type { PageResult, SearchMode } from '../../../shared/library/types.js';
import { AppStateProvider, useAppDispatch } from '../state/app-state-context';
import { Toolbar } from './Toolbar';

interface ScenarioProps {
  readonly query: string;
  readonly mode: SearchMode;
  readonly search: PageResult['search'];
  readonly platform?: CommandPlatform;
  readonly onExportAll?: () => void;
  readonly onTransfer?: () => void;
}

function installStub(): void {
  const library = { onPendingCountChanged: () => () => undefined } as unknown as OverlookApi['library'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { library };
}

function Scenario({ query, mode, search, platform = 'darwin', onExportAll, onTransfer }: ScenarioProps) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch({ type: 'query/set', query });
    dispatch({ type: 'searchMode/set', mode });
    dispatch({ type: 'search/status', search });
  }, [dispatch, mode, query, search]);
  return <Toolbar platform={platform} onImport={() => undefined} onExportAll={onExportAll} onTransfer={onTransfer} />;
}

function SearchToolbar(props: ScenarioProps) {
  return (
    <AppStateProvider>
      <Scenario {...props} />
    </AppStateProvider>
  );
}

const meta: Meta<typeof SearchToolbar> = {
  title: 'App/Toolbar/Search',
  component: SearchToolbar,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof SearchToolbar>;

// #1291: search mode is a menu button at the field's inline start, not a
// permanent Segmented beside it.
export const Modes: Story = {
  args: {
    query: 'a city street at dusk',
    mode: 'auto',
    search: { requestedMode: 'auto', appliedMode: 'fused', fallbackReason: null, indexed: 24, total: 24 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = within(canvasElement.ownerDocument.body);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Keyword + semantic results · 24 of 24 photos indexed');
    await expect(canvas.queryByRole('radio', { name: 'Semantic' })).not.toBeInTheDocument();
    const trigger = canvas.getByRole('button', { name: 'Search mode: Auto' });
    await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    // Auto shows no name on the button.
    await expect(trigger).not.toHaveTextContent('Auto');

    // Click opens the menu on the checked item; each item carries a description.
    await userEvent.click(trigger);
    const menu = doc.getByRole('menu', { name: 'Search mode' });
    const auto = within(menu).getByRole('menuitemradio', { name: 'Auto' });
    await expect(auto).toHaveAttribute('aria-checked', 'true');
    await expect(auto).toHaveFocus();
    await expect(auto).toHaveAccessibleDescription('Keyword and meaning together. Best for most searches.');
    await expect(within(menu).getByRole('menuitemradio', { name: 'Semantic' })).toHaveAccessibleDescription(
      'Finds photos by what’s in them, like ‘dog on a beach’.',
    );

    // Choosing Keyword updates the mode, names it on the button, returns
    // focus to the input, and announces the change.
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Keyword' }));
    await expect(doc.queryByRole('menu')).not.toBeInTheDocument();
    const input = canvas.getByRole('searchbox', { name: 'Search library' });
    await expect(input).toHaveFocus();
    const keywordTrigger = canvas.getByRole('button', { name: 'Search mode: Keyword' });
    await expect(keywordTrigger).toHaveTextContent('Keyword');
    await waitFor(async () => {
      await expect(doc.getByTestId('screen-reader-announcer-polite')).toHaveTextContent('Search mode: Keyword.');
    });

    // Alt+↓ from the input opens on the checked item; Esc closes with no
    // change and returns focus to the input.
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await expect(doc.getByRole('menuitemradio', { name: 'Keyword' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(doc.getByRole('menuitemradio', { name: 'Semantic' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(doc.queryByRole('menu')).not.toBeInTheDocument();
    await expect(input).toHaveFocus();
    await expect(canvas.getByRole('button', { name: 'Search mode: Keyword' })).toBeInTheDocument();

    // ↓ on the trigger opens it; Tab closes with no change back to the trigger.
    keywordTrigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(doc.getByRole('menuitemradio', { name: 'Keyword' })).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await expect(doc.queryByRole('menu')).not.toBeInTheDocument();
    await expect(keywordTrigger).toHaveFocus();

    await userEvent.click(canvas.getByRole('button', { name: 'Filters' }));
    await expect(canvas.getByRole('button', { name: 'RAW' })).toBeVisible();
  },
};

// A non-Auto mode names itself on the button.
export const NonAutoMode: Story = {
  args: {
    query: '',
    mode: 'semantic',
    search: { requestedMode: 'semantic', appliedMode: 'semantic', fallbackReason: null, indexed: 24, total: 24 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByRole('button', { name: 'Search mode: Semantic' });
    await expect(trigger).toHaveTextContent('Semantic');
  },
};

// The menu open, for review: Semantic stays selectable while it indexes, with
// the reason appended to its description.
export const ModeMenuOpen: Story = {
  args: {
    query: 'snowy mountain peaks',
    mode: 'semantic',
    search: { requestedMode: 'semantic', appliedMode: 'keyword', fallbackReason: 'indexing', indexed: 7, total: 24 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('button', { name: 'Search mode: Semantic' }));
    const semantic = doc.getByRole('menuitemradio', { name: 'Semantic' });
    await expect(semantic).toHaveFocus();
    await expect(semantic).not.toHaveAttribute('aria-disabled');
    await expect(semantic).toHaveAccessibleDescription(
      'Finds photos by what’s in them, like ‘dog on a beach’. Still indexing — keyword results until it finishes.',
    );
  },
};

export const EmptyQuery: Story = {
  args: {
    query: '',
    mode: 'auto',
    search: { requestedMode: 'auto', appliedMode: 'keyword', fallbackReason: null, indexed: 0, total: 0 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument();
    await expect(canvas.getByRole('searchbox', { name: 'Search library' })).toHaveValue('');
  },
};

export const IndexingFallback: Story = {
  args: {
    query: 'snowy mountain peaks',
    mode: 'semantic',
    search: { requestedMode: 'semantic', appliedMode: 'keyword', fallbackReason: 'indexing', indexed: 7, total: 24 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      'Semantic is still indexing; showing keyword results · 7 of 24 photos indexed',
    );
  },
};

const idle: PageResult['search'] = { requestedMode: 'auto', appliedMode: 'keyword', fallbackReason: null, indexed: 0, total: 0 };

// #1292: Import is the toolbar's only primary action. macOS reaches Transfer
// & Sync and Export All from its native menus, so the toolbar drops them
// even when the shell offers the handlers.
export const PrimaryActionsMac: Story = {
  args: { query: '', mode: 'auto', search: idle, platform: 'darwin', onExportAll: () => undefined, onTransfer: () => undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Import' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Transfer & Sync' })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Export All Unencrypted…' })).not.toBeInTheDocument();
  },
};

// Windows/Linux have no menu bar: the two actions stay on the toolbar until
// the titlebar Overlook menu takes them (#1293).
export const PrimaryActionsWindows: Story = {
  args: { query: '', mode: 'auto', search: idle, platform: 'win32', onExportAll: () => undefined, onTransfer: () => undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Import' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Transfer & Sync' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Export All Unencrypted…' })).toBeVisible();
  },
};
