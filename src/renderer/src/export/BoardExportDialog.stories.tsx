import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { Board } from '../../../shared/moodboard/board.js';
import { BoardExportDialog } from './BoardExportDialog';

const BOARD: Board = {
  id: 'board-story',
  title: 'Summer palette',
  notes: '',
  size: { width: 1600, height: 1200 },
  background: 'ink',
  placements: [
    {
      id: 'visible',
      photoId: 'photo-visible',
      x: 10,
      y: 20,
      w: 300,
      h: 200,
      rotation: 0,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      z: 1,
      groupId: null,
    },
    {
      id: 'locked',
      photoId: 'photo-locked',
      x: 400,
      y: 20,
      w: 300,
      h: 200,
      rotation: 0,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      z: 2,
      groupId: null,
    },
  ],
};

const runBoard = fn<OverlookApi['export']['runBoard']>();

function installStub(): void {
  let listener: ((payload: { done: number; total: number }) => void) | null = null;
  const exportApi: OverlookApi['export'] = {
    pickDestination: () => Promise.resolve({ path: '/Users/demo/Exports', authorization: '00000000-0000-4000-8000-000000000001' }),
    revokeDestination: () => Promise.resolve({ revoked: true }),
    run: () => Promise.resolve({ exported: 0, failed: 0, cancelled: 0, previewTranscodes: 0, failures: [] }),
    runAll: () => Promise.resolve({ exported: 0, failed: 0, cancelled: 0, previewTranscodes: 0, failures: [] }),
    runBoard: (request) => {
      void runBoard(request);
      listener?.({ done: request.board.placements.length, total: request.board.placements.length });
      return Promise.resolve({
        exported: true,
        cancelled: false,
        rendered: 1,
        skipped: 1,
        skippedLocked: 1,
        skippedUnavailable: 0,
        fileName: 'Summer palette.png',
        path: '/Users/demo/Exports/Summer palette.png',
      });
    },
    cancel: () => Promise.resolve({}),
    onProgress: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { export: exportApi };
}

const meta: Meta<typeof BoardExportDialog> = {
  title: 'App/BoardExportDialog',
  component: BoardExportDialog,
  args: { board: BOARD, availability: { visible: 'available', locked: 'locked' }, onClose: fn() },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof BoardExportDialog>;

export const ExportWithSkippedPlacement: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialogElement = body.getByRole('dialog', { name: 'Export board' });
    const dialog = within(dialogElement);
    await expect(dialogElement).toBeVisible();
    await expect(dialog.getByLabelText('Width')).toHaveValue(1600);
    await expect(dialog.getByLabelText('Height')).toHaveValue(1200);
    await userEvent.click(dialog.getByRole('radio', { name: 'Display P3' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Choose folder…' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Export board' }));
    await expect(dialog.getByText('Board exported with 1 placement.')).toBeVisible();
    await expect(dialog.getByText('1 locked or unavailable placement was skipped.')).toBeVisible();
    await expect(runBoard).toHaveBeenCalledWith(expect.objectContaining({ colorSpace: 'display-p3', output: BOARD.size }));
  },
};
