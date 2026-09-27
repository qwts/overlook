import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, within } from 'storybook/test';

import { Switch } from '../components/Switch';
import { Field, FieldSelect } from './Field';
import { SettingsGroup, settingsGroupProblems } from './SettingsGroup';

// #1296 (Pass C spec, Group): All Photos, the first SettingsGroup, between
// the rows around it in the General pane.

function AllPhotos(): ReactElement {
  const [show, setShow] = useState(true);
  const [minimum, setMinimum] = useState('');
  return (
    <div className="ovl-settings__fields" style={{ width: 520, padding: 'var(--space-4)', background: 'var(--gray-1)' }}>
      <Field label="Trash retention" hint="Controls automatic permanent deletion.">
        <Switch checked onChange={() => undefined} />
      </Field>
      <SettingsGroup
        heading="All Photos"
        hint="These rules change only what All Photos shows. Albums, search, backup, export, and the RAW and Unavailable sources are never affected."
      >
        <Field label="Show unavailable items">
          <Switch checked={show} onChange={setShow} />
        </Field>
        <Field label="Minimum size" hint="Items whose dimensions are unknown are always shown, whatever the minimum.">
          <FieldSelect value={minimum} onChange={(event) => setMinimum(event.target.value)}>
            <option value="">None — show every size</option>
            <option value="1">1 MP and larger</option>
          </FieldSelect>
        </Field>
      </SettingsGroup>
      <Field label="Appearance" hint="Changes apply immediately.">
        <Switch checked={false} onChange={() => undefined} />
      </Field>
    </div>
  );
}

const meta: Meta = {
  title: 'App/Settings/SettingsGroup',
  render: () => <AllPhotos />,
};

export default meta;
type Story = StoryObj;

export const AllPhotosGroup: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole('region', { name: 'All Photos' });
    await expect(region).toHaveAccessibleDescription(/These rules change only what All Photos shows/u);
    await expect(within(region).getByRole('heading', { level: 3, name: 'All Photos' })).toBeVisible();
    await expect(within(region).getByRole('switch', { name: 'Show unavailable items' })).toBeVisible();
    await expect(within(region).getByRole('combobox', { name: 'Minimum size' })).toBeVisible();
    await expect(settingsGroupProblems(region)).toEqual([]);
    // Its rows sit at the same indent as the rows around it.
    const indent = (label: string): number =>
      canvas.getByText(label).closest('.ovl-settings__field')?.getBoundingClientRect().left ?? Number.NaN;
    await expect(indent('Show unavailable items')).toBe(indent('Trash retention'));
    await expect(indent('Minimum size')).toBe(indent('Appearance'));
    await expect(canvasElement.querySelector('.ovl-settings__field .ovl-settings__field')).toBeNull();
    // The heading sits 16px below the row above it.
    const above = canvas.getByText('Trash retention').closest('.ovl-settings__field')?.getBoundingClientRect().bottom ?? 0;
    const heading = within(region).getByRole('heading').getBoundingClientRect().top;
    await expect(Math.round(heading - above)).toBeGreaterThanOrEqual(16);
  },
};
