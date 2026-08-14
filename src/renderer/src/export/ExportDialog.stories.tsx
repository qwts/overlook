import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ExportDialog } from './ExportDialog';
import type { OverlookApi } from '../../../shared/ipc/api.js';

// #99 exit criteria: copy/pixel match to the mock, switch-off disables the
// button + shows the warning, and phases transition on engine events (the
// decorator installs a stub window.overlook.export that streams progress).

const IDS = ['A', 'B', 'C'];

function installStub(): void {
  const exportApi: OverlookApi['export'] = {
    pickDestination: () =>
      Promise.resolve({ path: '/Users/demo/Exports', authorization: 'storybook-export-authorization' }),
    run: async () => {
      for (let done = 1; done <= IDS.length; done += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        listener?.({ done, total: IDS.length });
      }
      return { exported: IDS.length, failed: 0, cancelled: 0, previewTranscodes: 1 };
    },
    cancel: () => Promise.resolve({}),
    onProgress: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  let listener: ((payload: { done: number; total: number }) => void) | null = null;
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { export: exportApi };
}

const meta: Meta<typeof ExportDialog> = {
  title: 'App/ExportDialog',
  component: ExportDialog,
  args: { open: true, photoIds: IDS, onClose: fn() },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof ExportDialog>;

export const Options: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByText('3 photos selected')).toBeVisible();
    await expect(body.getByText('Files are stored encrypted. Turn this on to write plain, openable files to disk.')).toBeVisible();
    // Decrypt ON by default; Export disabled only by the missing destination.
    await expect(body.getByRole('button', { name: /Export 3 photos/u })).toBeDisabled();
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await expect(body.getByRole('button', { name: /Export 3 photos/u })).toBeEnabled();
    // Switch OFF: the button disables and the verbatim warning appears.
    await userEvent.click(body.getByRole('switch', { name: 'Decrypt originals' }));
    await expect(body.getByRole('button', { name: /Export 3 photos/u })).toBeDisabled();
    await expect(body.getByRole('alert')).toHaveTextContent("Without decryption, exported files can't be opened outside Overlook.");
    await userEvent.click(body.getByRole('switch', { name: 'Decrypt originals' }));
    await expect(body.queryByRole('alert')).toBeNull();
  },
};

export const PhasesOnEngineEvents: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await userEvent.click(body.getByRole('button', { name: /Export 3 photos/u }));
    // Running: the single cyan bar with the decrypt label, fed by events…
    await expect(body.getByText('Decrypting & writing files')).toBeVisible();
    // …then done on the engine's resolution, with the preview-capped note.
    await waitFor(
      () => expect(body.getByText(/3 photos exported and decrypted\. 1 from RAW previews \(preview resolution\)\./u)).toBeVisible(),
      {
        timeout: 3000,
      },
    );
    await expect(body.getByRole('button', { name: 'Done' })).toBeVisible();
  },
};
