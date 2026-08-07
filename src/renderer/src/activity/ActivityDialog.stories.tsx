import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { ActivityDialog } from './ActivityDialog';

const events = [
  {
    sequence: 2,
    eventId: 'event-2',
    operationId: 'operation-2',
    eventType: 'photo.trashed' as const,
    schemaVersion: 1 as const,
    occurredAt: '2026-07-20T18:30:00.000Z',
    actorClass: 'local-user' as const,
    rootCorrelationId: 'operation-2',
    causationEventId: null,
    entityIds: ['photo-a', 'photo-b'],
    outcome: 'succeeded' as const,
    payload: { count: 2 },
    supersedesEventId: null,
  },
  {
    sequence: 1,
    eventId: 'event-1',
    operationId: 'operation-1',
    eventType: 'import.completed' as const,
    schemaVersion: 1 as const,
    occurredAt: '2026-07-20T17:00:00.000Z',
    actorClass: 'local-user' as const,
    rootCorrelationId: 'operation-1',
    causationEventId: null,
    entityIds: [],
    outcome: 'partial' as const,
    payload: { imported: 12, failed: 1 },
    supersedesEventId: null,
  },
];

const meta: Meta<typeof ActivityDialog> = {
  title: 'Library/ActivityDialog',
  component: ActivityDialog,
  decorators: [
    (Story) => {
      (globalThis as { overlook?: unknown }).overlook = {
        activity: { page: () => Promise.resolve({ events, nextCursor: null }) },
        history: {
          status: () =>
            Promise.resolve({
              undo: {
                recordId: 'command-1',
                commandId: 'photo.trash',
                classification: 'immediately-reversible',
                status: 'available',
                reason: 'ready',
                expiresAt: '2026-08-20T18:30:00.000Z',
              },
              redo: {
                recordId: null,
                commandId: null,
                classification: null,
                status: 'unavailable',
                reason: 'empty-stack',
                expiresAt: null,
              },
            }),
          undo: fn(() => Promise.resolve({ applied: true })),
          redo: fn(),
        },
      };
      return <Story />;
    },
  ],
  args: { open: true, onClose: fn() },
};

export default meta;
type Story = StoryObj<typeof ActivityDialog>;

export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Moved 2 photos to Trash')).toBeVisible();
    await expect(canvas.getByText('Imported 12 photos')).toBeVisible();
    await expect(canvas.getByText('Completed with some items unresolved')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Redo' })).toBeDisabled();
    await expect(canvas.getByText('No action available')).toBeVisible();
    await expect(canvas.getAllByRole('button', { name: 'Copy activity event ID' })).toHaveLength(2);
    await expect(canvas.getAllByRole('button', { name: 'Copy activity timestamp' })).toHaveLength(2);
    await userEvent.click(canvas.getByRole('button', { name: 'Undo' }));
  },
};
