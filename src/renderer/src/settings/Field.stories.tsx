import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, within } from 'storybook/test';

import { Segmented } from '../components/Segmented';
import { Switch } from '../components/Switch';
import { Field } from './Field';

// #1295 (Pass C spec): the settings row. The label keeps a 220px basis; a
// control that would squeeze it narrower wraps below it, start-aligned.

function TrashRetention(): ReactElement {
  const [value, setValue] = useState('30');
  return (
    <Field label="Trash retention" hint="Photos in the Trash are deleted for good after this long.">
      <Segmented
        value={value}
        options={['Off', '7 days', '30 days', '90 days'].map((label, index) => ({
          value: ['off', '7', '30', '90'][index] ?? label,
          label,
        }))}
        onChange={setValue}
      />
    </Field>
  );
}

function Rows(): ReactElement {
  const [on, setOn] = useState(true);
  return (
    <div className="ovl-settings__fields">
      <TrashRetention />
      <Field label="Lock when hidden" hint="Also lock when the app is hidden or minimized.">
        <Switch checked={on} onChange={setOn} />
      </Field>
    </div>
  );
}

function Frame({ width, children }: { readonly width: number; readonly children: ReactElement }): ReactElement {
  return <div style={{ width, padding: 'var(--space-4)', background: 'var(--gray-1)' }}>{children}</div>;
}

const meta: Meta = {
  title: 'App/Settings/Field',
};

export default meta;
type Story = StoryObj;

function parts(canvasElement: HTMLElement, label: string): { row: DOMRect; text: DOMRect; control: DOMRect } {
  const row = within(canvasElement).getByText(label).closest('.ovl-settings__field');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${label}`);
  const rect = (selector: string): DOMRect => row.querySelector(selector)?.getBoundingClientRect() ?? new DOMRect();
  return { row: row.getBoundingClientRect(), text: rect('.ovl-settings__fieldText'), control: rect('.ovl-settings__fieldControl') };
}

// Wide enough: every control sits beside its label, at the row's end.
export const AutoInline: Story = {
  render: () => (
    <Frame width={640}>
      <Rows />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const label of ['Trash retention', 'Lock when hidden']) {
      const { row, text, control } = parts(canvasElement, label);
      await expect(control.top).toBe(text.top);
      await expect(Math.round(control.right)).toBe(Math.round(row.right));
    }
    await expect(canvas.getByRole('radiogroup', { name: 'Trash retention' })).toHaveAccessibleDescription(
      'Photos in the Trash are deleted for good after this long.',
    );
    await expect(canvas.getByRole('switch', { name: 'Lock when hidden' })).toHaveAccessibleDescription(
      'Also lock when the app is hidden or minimized.',
    );
    await expect(canvas.queryByRole('group')).toBeNull();
  },
};

// Narrow: Trash retention's four options would squeeze its label under 220px,
// so the control wraps below it, start-aligned. The switch still fits inline.
export const AutoWrapped: Story = {
  render: () => (
    <Frame width={420}>
      <Rows />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const trash = parts(canvasElement, 'Trash retention');
    await expect(trash.control.top).toBeGreaterThanOrEqual(trash.text.bottom);
    await expect(Math.round(trash.control.left)).toBe(Math.round(trash.row.left));
    await expect(trash.text.width).toBeGreaterThanOrEqual(Math.min(220, trash.row.width));
    const lock = parts(canvasElement, 'Lock when hidden');
    await expect(lock.control.top).toBe(lock.text.top);
    await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth);
  },
};

// A compound control spans the row under its label and stays a group.
export const Stacked: Story = {
  render: () => (
    <Frame width={560}>
      <Field layout="stacked" label="Share diagnostics" hint="Anonymous crash reports only — never photo content or metadata.">
        <div className="ovl-settings__diagnosticsControl">
          <Switch checked accessibleLabel="Share diagnostics" />
          <span className="ovl-diagnostics__status">No reports yet.</span>
        </div>
      </Field>
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const { row, text, control } = parts(canvasElement, 'Share diagnostics');
    await expect(control.top).toBeGreaterThanOrEqual(text.bottom);
    await expect(Math.round(control.width)).toBe(Math.round(row.width));
    const group = canvas.getByRole('group', { name: 'Share diagnostics' });
    await expect(group).toHaveAccessibleDescription('Anonymous crash reports only — never photo content or metadata.');
    await expect(canvas.getByRole('switch', { name: 'Share diagnostics' })).toBeVisible();
  },
};

// No hint: the control is named by the label and described by nothing.
export const NoHint: Story = {
  render: () => (
    <Frame width={560}>
      <Field label="Sort order">
        <Segmented value="date" options={['date', 'name', 'size']} onChange={() => undefined} />
      </Field>
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('radiogroup', { name: 'Sort order' });
    await expect(group).not.toHaveAttribute('aria-describedby');
  },
};

// RTL (en-XB pseudo-locale): the label starts on the right and the control
// sits at the inline end, on the left; a wrapped control starts on the right.
export const Rtl: Story = {
  globals: { locale: 'en-XB' },
  render: () => (
    <div dir="rtl">
      <Frame width={420}>
        <Rows />
      </Frame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const lock = parts(canvasElement, 'Lock when hidden');
    await expect(Math.round(lock.control.left)).toBe(Math.round(lock.row.left));
    const trash = parts(canvasElement, 'Trash retention');
    await expect(Math.round(trash.control.right)).toBe(Math.round(trash.row.right));
  },
};
