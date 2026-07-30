import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { RenameLibraryDialog } from './RenameLibraryDialog';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { LibraryDescriptor } from '../../../shared/library/registry.js';

// #686 / ADR-0022: rename the library's folder in place. The form validates
// the name live (conservative cross-platform rules), refusals render decided
// copy, and success shows the old → new path. The decorator stubs the rename
// IPC; real renames round-trip in the E2E lane.

const ALPHA_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';

function lib(overrides: Partial<LibraryDescriptor> = {}): LibraryDescriptor {
  return {
    id: ALPHA_ID,
    name: 'Alpha',
    path: '/Users/ansel/Pictures/Overlook/Alpha',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastOpenedAt: '2026-07-17T08:00:00.000Z',
    missing: false,
    open: false,
    lockedBy: null,
    ...overrides,
  };
}

type RenameOutcome = Awaited<ReturnType<OverlookApi['libraries']['renameFolder']>>;

function installStub(outcome?: RenameOutcome): { readonly calls: string[] } {
  const calls: string[] = [];
  const libraries = {
    renameFolder: ({ id, newName }: { id: string; newName: string }) => {
      calls.push(`rename:${id}:${newName}`);
      return Promise.resolve(
        outcome ?? {
          ok: true as const,
          outcome: 'moved' as const,
          mode: 'rename' as const,
          items: 1204,
          bytes: 48_211_890_176,
          sourcePath: '/Users/ansel/Pictures/Overlook/Alpha',
          destPath: `/Users/ansel/Pictures/Overlook/${newName}`,
        },
      );
    },
  } as unknown as OverlookApi['libraries'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { libraries };
  return { calls };
}

const meta: Meta<typeof RenameLibraryDialog> = {
  title: 'App/RenameLibraryDialog',
  component: RenameLibraryDialog,
  args: { onClose: fn(), library: lib() },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof RenameLibraryDialog>;

export const Form: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('dialog', { name: 'Rename library folder' })).toBeVisible();
    // Prefilled with the current folder name and disabled until it changes.
    await expect(body.getByTestId('rename-name')).toHaveValue('Alpha');
    await expect(body.getByTestId('rename-confirm')).toBeDisabled();
    // Custody assurance: identity and alias stay untouched.
    await expect(body.getByText(/library ID, keys, albums, backups, and display name stay/)).toBeVisible();
  },
};

export const LiveValidationObjections: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const input = body.getByTestId('rename-name');
    await userEvent.clear(input);
    await userEvent.type(input, 'CON');
    await expect(body.getByTestId('rename-objection')).toHaveTextContent(/Windows reserves this name/);
    await expect(body.getByTestId('rename-confirm')).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'photos/2026');
    await expect(body.getByTestId('rename-objection')).toHaveTextContent(/cannot contain/);
    await userEvent.clear(input);
    await userEvent.type(input, 'Family Photos');
    await expect(body.queryByTestId('rename-objection')).toBeNull();
    await expect(body.getByTestId('rename-preview')).toHaveTextContent('Alpha → Family Photos');
    await expect(body.getByTestId('rename-confirm')).toBeEnabled();
  },
};

export const RenameSucceeds: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const input = body.getByTestId('rename-name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Family Photos');
    await userEvent.click(body.getByTestId('rename-confirm'));
    await expect(await body.findByTestId('rename-success')).toBeVisible();
    await expect(body.getByText(/new name in Finder or Explorer/)).toBeVisible();
    await expect(body.getByText(/Alpha → \/Users\/ansel\/Pictures\/Overlook\/Family Photos/)).toBeVisible();
  },
};

export const EngineRefusalRenders: Story = {
  decorators: [
    (Story) => {
      installStub({ ok: false, reason: 'destination-not-empty', detail: 'a folder named "Family Photos" already exists' });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const input = body.getByTestId('rename-name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Family Photos');
    await userEvent.click(body.getByTestId('rename-confirm'));
    const refusal = await body.findByTestId('rename-refusal');
    await expect(refusal).toHaveTextContent(/already exists here — Overlook never overwrites or merges/);
    await expect(refusal).toHaveTextContent(/a folder named "Family Photos" already exists/);
  },
};

export const OpenLibraryNote: Story = {
  args: { library: lib({ open: true }) },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByText(/closes it, renames the folder, and reopens it/)).toBeVisible();
  },
};
