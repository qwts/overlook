import { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { PageResult, SearchMode } from '../../../shared/library/types.js';
import { AppStateProvider, useAppDispatch } from '../state/app-state-context';
import { Toolbar } from './Toolbar';

interface ScenarioProps {
  readonly query: string;
  readonly mode: SearchMode;
  readonly search: PageResult['search'];
}

function installStub(): void {
  const library = { onPendingCountChanged: () => () => undefined } as unknown as OverlookApi['library'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { library };
}

function Scenario({ query, mode, search }: ScenarioProps) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    dispatch({ type: 'query/set', query });
    dispatch({ type: 'searchMode/set', mode });
    dispatch({ type: 'search/status', search });
  }, [dispatch, mode, query, search]);
  return <Toolbar platform="darwin" />;
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

export const Modes: Story = {
  args: {
    query: 'a city street at dusk',
    mode: 'auto',
    search: { requestedMode: 'auto', appliedMode: 'fused', fallbackReason: null, indexed: 24, total: 24 },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Keyword + semantic results · 24 of 24 photos indexed');
    await userEvent.click(canvas.getByRole('radio', { name: 'Semantic' }));
    await expect(canvas.getByRole('radio', { name: 'Semantic' })).toBeChecked();
    await userEvent.click(canvas.getByRole('radio', { name: 'Keyword' }));
    await expect(canvas.getByRole('radio', { name: 'Keyword' })).toBeChecked();
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
