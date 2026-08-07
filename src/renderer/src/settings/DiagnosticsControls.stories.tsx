import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import { DiagnosticsControls } from './DiagnosticsControls';

const diagnostics: OverlookApi['diagnostics'] = {
  list: () =>
    Promise.resolve({
      reports: [
        {
          eventId: 'diagnostic-event-807',
          kind: 'renderer-process-gone',
          capturedAt: '2026-08-07T12:00:00.000Z',
          payload: '{"kind":"renderer-process-gone"}',
          encryptedBytes: 96,
        },
      ],
    }),
  delete: () => Promise.resolve({ deleted: true }),
  purge: () => Promise.resolve({ deleted: 1 }),
  export: () => Promise.resolve({ exported: true, count: 1 }),
};

const meta: Meta<typeof DiagnosticsControls> = {
  title: 'App/DiagnosticsControls',
  component: DiagnosticsControls,
  args: { enabled: true },
  decorators: [
    (Story) => {
      (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { diagnostics };
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof DiagnosticsControls>;

export const CopyableReport: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByText('1 pending local report')).toBeVisible());
    await userEvent.click(body.getByRole('button', { name: 'Review reports…' }));
    await expect(body.getByText('diagnostic-event-807')).toBeVisible();
    await expect(body.getByText('{"kind":"renderer-process-gone"}')).toBeVisible();
    await expect(body.getByRole('button', { name: 'Copy diagnostic event ID' })).toBeVisible();
    await expect(body.getByRole('button', { name: 'Copy diagnostic payload' })).toBeVisible();
  },
};
