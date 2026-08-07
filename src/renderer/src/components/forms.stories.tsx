import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import { Chip } from './Chip';
import { SearchField } from './SearchField';
import { Segmented } from './Segmented';

const meta: Meta = {
  title: 'Forms/Toolbar',
};

export default meta;

function SearchDemo(): ReactElement {
  const [value, setValue] = useState('');
  return (
    <div style={{ padding: 'var(--space-7)' }}>
      <SearchField value={value} onChange={setValue} shortcut="⌘K" width={300} />
    </div>
  );
}

export const Search: StoryObj = {
  render: () => <SearchDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('searchbox');
    // Hint shows until focus.
    await expect(canvas.getByText('⌘K')).toBeInTheDocument();
    await userEvent.type(input, 'kyoto');
    await expect(input).toHaveValue('kyoto');
    await expect(canvas.queryByText('⌘K')).not.toBeInTheDocument();
    // Clear affordance empties and keeps typing possible.
    await userEvent.click(canvas.getByRole('button', { name: 'Clear search' }));
    await expect(input).toHaveValue('');
  },
};

function ChipsDemo({ onRemove }: { readonly onRemove?: (() => void) | undefined }): ReactElement {
  const [selected, setSelected] = useState(false);
  const [removed, setRemoved] = useState(false);
  if (removed) {
    return <div style={{ padding: 'var(--space-7)' }} />;
  }
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', padding: 'var(--space-7)' }}>
      <Chip
        selected={selected}
        icon="star"
        onClick={() => {
          setSelected((s) => !s);
        }}
      >
        Favorites
      </Chip>
      <Chip
        icon="cloud"
        onRemove={() => {
          setRemoved(true);
          onRemove?.();
        }}
      >
        Offloaded
      </Chip>
      <Chip selected>RAW</Chip>
    </div>
  );
}

export const Chips: StoryObj<{ onRemove: () => void }> = {
  args: { onRemove: fn() },
  render: (args) => <ChipsDemo onRemove={args.onRemove} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const favorites = canvas.getByRole('button', { name: /Favorites/ });
    await expect(favorites).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(favorites);
    await expect(favorites).toHaveAttribute('aria-pressed', 'true');
    // Remove × takes out the chip without toggling it.
    await userEvent.click(canvas.getByRole('button', { name: 'Remove filter' }));
    await expect(args.onRemove).toHaveBeenCalledOnce();
    await expect(canvas.queryByText('Offloaded')).not.toBeInTheDocument();
  },
};

function SegmentedDemo(): ReactElement {
  const [view, setView] = useState('grid');
  const [mode, setMode] = useState('copy');
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)', padding: 'var(--space-7)', justifyItems: 'start' }}>
      <Segmented
        label="View"
        value={view}
        onChange={setView}
        options={[
          { value: 'grid', label: 'Grid', icon: 'layout-grid', iconOnly: true },
          { value: 'list', label: 'List', icon: 'list', iconOnly: true },
        ]}
      />
      <Segmented label="On import" value={mode} onChange={setMode} options={['copy', 'move']} />
    </div>
  );
}

export const SegmentedControls: StoryObj = {
  render: () => <SegmentedDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grid = canvas.getByRole('radio', { name: 'Grid' });
    const list = canvas.getByRole('radio', { name: 'List' });
    await expect(grid).toBeChecked();
    // Exclusivity on click.
    await userEvent.click(list);
    await expect(list).toBeChecked();
    await expect(grid).not.toBeChecked();
    // Arrow keys move the exclusive selection.
    list.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(grid).toBeChecked();
    await expect(list).not.toBeChecked();
  },
};
