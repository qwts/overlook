import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { ReactElement } from 'react';
import { expect, fireEvent, userEvent, within } from 'storybook/test';

import { Checkbox } from './Checkbox';
import { Slider } from './Slider';
import { Switch } from './Switch';

const meta: Meta = {
  title: 'Forms/Inputs',
};

export default meta;

function SliderDemo(): ReactElement {
  const [zoom, setZoom] = useState(160);
  const [bandwidth, setBandwidth] = useState(100);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)', padding: 'var(--space-7)', justifyItems: 'start' }}>
      <Slider label="Zoom" value={zoom} min={96} max={320} onChange={setZoom} />
      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
        <Slider label="Upload bandwidth limit" value={bandwidth} min={10} max={100} step={10} onChange={setBandwidth} width={180} />
        <span className="mono-data" style={{ color: 'var(--text-muted)' }}>
          {bandwidth === 100 ? 'Unlimited' : `${String(bandwidth)}%`}
        </span>
      </div>
    </div>
  );
}

export const Sliders: StoryObj = {
  render: () => <SliderDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const zoom = canvas.getByRole('slider', { name: 'Zoom' });
    await expect(zoom).toHaveValue('160');
    // Native range inputs only increment on real (trusted) key events, which
    // synthetic tests can't send — drive the change event instead; keyboard
    // operability comes free with the native input.
    await fireEvent.change(zoom, { target: { value: '200' } });
    await expect(zoom).toHaveValue('200');
  },
};

function SwitchDemo(): ReactElement {
  const [auto, setAuto] = useState(true);
  const [wifi, setWifi] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-7)', justifyItems: 'start' }}>
      <Switch checked={auto} onChange={setAuto} label="Back up new imports automatically" />
      <Switch checked={wifi} onChange={setWifi} label="Wi-Fi only" />
      <Switch checked disabled label="Encrypt originals" />
    </div>
  );
}

export const Switches: StoryObj = {
  render: () => <SwitchDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const wifi = canvas.getByRole('switch', { name: 'Wi-Fi only' });
    await expect(wifi).not.toBeChecked();
    await userEvent.click(wifi);
    await expect(wifi).toBeChecked();
    // The locked-on pattern: encrypt cannot be disabled.
    const encrypt = canvas.getByRole('switch', { name: 'Encrypt originals' });
    await expect(encrypt).toBeChecked();
    await expect(encrypt).toBeDisabled();
    encrypt.click();
    await expect(encrypt).toBeChecked();
  },
};

function CheckboxDemo(): ReactElement {
  const [thumbs, setThumbs] = useState(true);
  const [pick, setPick] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-7)', justifyItems: 'start' }}>
      <Checkbox checked={thumbs} onChange={setThumbs} label="Generate thumbnails on import" />
      <Checkbox checked={false} indeterminate label="Some of 1,204 selected" />
      <Checkbox checked disabled label="Locked on" />
      <Checkbox checked={pick} onChange={setPick} label="Select Alpha to move" hideLabel />
    </div>
  );
}

export const Checkboxes: StoryObj = {
  render: () => <CheckboxDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const thumbs = canvas.getByRole('checkbox', { name: 'Generate thumbnails on import' });
    await expect(thumbs).toBeChecked();
    await userEvent.click(thumbs);
    await expect(thumbs).not.toBeChecked();
    const partial = canvas.getByRole('checkbox', { name: 'Some of 1,204 selected' });
    await expect(partial).toHaveProperty('indeterminate', true);
    // hideLabel (#1298): named for assistive technology, box only on screen.
    const hidden = canvas.getByRole('checkbox', { name: 'Select Alpha to move' });
    const hiddenText = canvas.getByText('Select Alpha to move');
    await expect(hiddenText).toHaveClass('ovl-sr-only');
    await expect(hiddenText.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    // The box alone is 15px; the label keeps a 24px pointer target.
    const target = hidden.closest('label')?.getBoundingClientRect();
    await expect(target?.width).toBeGreaterThanOrEqual(24);
    await expect(target?.height).toBeGreaterThanOrEqual(24);
    await userEvent.click(hidden);
    await expect(hidden).toBeChecked();
  },
};
