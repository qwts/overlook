import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { CopyableValue } from './CopyableValue';

const LIBRARY_ID = '01K20Y3KQX6Z90V8Y3H2TK7W5S';
const HASH = '8B9A4F2E1D7C6A5032BB928C5E470D59';
const successfulCopy = fn((_value: string) => Promise.resolve());
const failedCopy = fn((_value: string) => Promise.reject(new Error('clipboard denied')));

const meta: Meta<typeof CopyableValue> = {
  title: 'Core/CopyableValue',
  component: CopyableValue,
  parameters: { layout: 'centered' },
};

export default meta;
type Story = StoryObj<typeof CopyableValue>;

export const SelectableAndKeyboardCopyable: Story = {
  args: { value: LIBRARY_ID, label: 'library ID', copy: successfulCopy },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const value = canvas.getByText(LIBRARY_ID);
    const style = getComputedStyle(value);
    await expect(style.userSelect).toBe('text');
    await expect(style.getPropertyValue('-webkit-app-region')).toBe('no-drag');

    const range = document.createRange();
    range.selectNodeContents(value);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    await expect(selection?.toString()).toBe(LIBRARY_ID);
    selection?.removeAllRanges();

    await userEvent.tab();
    const button = canvas.getByRole('button', { name: 'Copy library ID' });
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(successfulCopy).toHaveBeenCalledWith(LIBRARY_ID);
    await expect(canvas.getByTestId('screen-reader-announcer-polite')).toHaveTextContent('Copied library ID.');
  },
};

export const AnnouncesClipboardFailure: Story = {
  args: { value: HASH, label: 'content hash', copy: failedCopy },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Copy content hash' }));
    await expect(failedCopy).toHaveBeenCalledWith(HASH);
    await expect(canvas.getByTestId('screen-reader-announcer-assertive')).toHaveTextContent('Could not copy content hash.');
  },
};
