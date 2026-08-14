import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { LibrarySwitcher } from './LibrarySwitcher';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { LibraryDescriptor } from '../../../shared/library/registry.js';

// #386 exit criteria: every designed switcher state renders and its flow
// asserts — list rows (open/available/missing/locked-elsewhere), refusal
// banners, the reassurance-forward remove confirm, the create flow, and
// keyboard operability. The decorator stubs the libraries IPC; the real
// switch round-trips in the E2E lane.

const OPEN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const BETA_ID = '01BRZ3NDEKTSV4RRFFQ69G5FAB';

function lib(overrides: Partial<LibraryDescriptor>): LibraryDescriptor {
  return {
    id: OPEN_ID,
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

const LIBRARIES: readonly LibraryDescriptor[] = [
  lib({ open: true }),
  lib({ id: BETA_ID, name: 'Beta', path: '/Users/ansel/Pictures/Overlook/Beta', lastOpenedAt: '2026-07-16T08:00:00.000Z' }),
  lib({ id: '01CRZ3NDEKTSV4RRFFQ69G5FAC', name: 'Field Archive', path: '/Volumes/Field/Overlook', lastOpenedAt: null }),
  lib({ id: '01DRZ3NDEKTSV4RRFFQ69G5FAD', name: 'Clara — MacBook', path: '/Volumes/Shared/Clara', lockedBy: 'CLARAS-MACBOOK' }),
  lib({ id: '01ERZ3NDEKTSV4RRFFQ69G5FAE', name: 'ExpeditionX 2026', path: '/Volumes/ExpeditionX/Overlook', missing: true }),
];

interface StubOptions {
  readonly libraries?: readonly LibraryDescriptor[];
  readonly current?: LibraryDescriptor;
  readonly openOutcome?: Awaited<ReturnType<OverlookApi['libraries']['open']>>;
  readonly openRejects?: boolean;
  readonly addOutcome?: Awaited<ReturnType<OverlookApi['libraries']['add']>>;
}

function installStub(options: StubOptions = {}): { readonly calls: string[] } {
  const calls: string[] = [];
  let currentLibraries = [...(options.libraries ?? LIBRARIES)];
  const libraries = {
    list: () => Promise.resolve({ libraries: currentLibraries }),
    current: () => Promise.resolve({ library: options.current ?? currentLibraries.find((entry) => entry.open) ?? LIBRARIES[0] }),
    open: ({ id }: { id: string }) => {
      calls.push(`open:${id}`);
      if (options.openRejects === true) return Promise.reject(new Error('IPC_HANDLER_FAILED'));
      // Default: hang like the real switch (the window reloads mid-await).
      if (options.openOutcome === undefined) return new Promise(() => undefined);
      return Promise.resolve(options.openOutcome);
    },
    create: ({ name }: { name: string }) => {
      calls.push(`create:${name}`);
      return Promise.resolve({ library: lib({ id: BETA_ID, name }) });
    },
    remove: ({ id }: { id: string }) => {
      calls.push(`remove:${id}`);
      return Promise.resolve({ removed: true });
    },
    setDisplayName: ({ id, name }: { id: string; name: string }) => {
      calls.push(`display-name:${id}:${name}`);
      const updated = currentLibraries.find((entry) => entry.id === id);
      if (updated === undefined) return Promise.reject(new Error('missing fixture'));
      const renamed = { ...updated, name };
      currentLibraries = currentLibraries.map((entry) => (entry.id === id ? renamed : entry));
      return Promise.resolve({ library: renamed });
    },
    resetDisplayName: ({ id }: { id: string }) => {
      calls.push(`display-name-reset:${id}`);
      const updated = currentLibraries.find((entry) => entry.id === id);
      if (updated === undefined) return Promise.reject(new Error('missing fixture'));
      const name = updated.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? updated.name;
      const renamed = { ...updated, name };
      currentLibraries = currentLibraries.map((entry) => (entry.id === id ? renamed : entry));
      return Promise.resolve({ library: renamed });
    },
    add: () => {
      calls.push('add');
      return Promise.resolve(options.addOutcome ?? { ok: true as const, library: lib({ id: BETA_ID, name: 'Added' }) });
    },
    pickLocation: () => {
      calls.push('pick-location');
      return Promise.resolve({ path: '/Users/ansel/External/NewHome' });
    },
    pickCreateLocation: () => {
      calls.push('pick-create-location');
      return Promise.resolve({ path: '/Users/ansel/External/NewHome' });
    },
    // The per-row Move action mounts the wizard, which subscribes and probes.
    onMoveProgress: () => () => undefined,
    probeMove: () =>
      Promise.resolve({
        ok: true as const,
        mode: 'copy' as const,
        requiredBytes: 1_000,
        items: 3,
        freeBytes: 9_000_000_000,
        network: false,
        lockedBy: null,
      }),
    pendingMoves: () => Promise.resolve({ pending: [] }),
  } as unknown as OverlookApi['libraries'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { libraries };
  return { calls };
}

const meta: Meta<typeof LibrarySwitcher> = {
  title: 'App/LibrarySwitcher',
  component: LibrarySwitcher,
  args: { onClose: fn() },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof LibrarySwitcher>;

export const AllRowStates: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('dialog', { name: 'Libraries' })).toBeVisible();
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await expect(body.getByText('5 registered')).toBeVisible();
    // The open library carries its badge; machine data renders mono.
    await expect(body.getByText('Open now')).toBeVisible();
    await expect(body.getByText('/Users/ansel/Pictures/Overlook/Alpha')).toBeVisible();
    // Missing volume row: badge + reconnect hint.
    await expect(body.getByText('Missing')).toBeVisible();
    await expect(body.getByText('Reconnect the volume to open this library')).toBeVisible();
    // Locked-elsewhere row names the host.
    await expect(body.getByText('Open on CLARAS-MACBOOK')).toBeVisible();
    // Never-opened stamp.
    await expect(body.getByText('Never opened')).toBeVisible();
  },
};

export const EditDisplayNameAndDisambiguateDuplicates: Story = {
  args: { onCurrentNameChange: fn() },
  decorators: [
    (Story) => {
      installStub({
        libraries: [lib({ open: true }), lib({ id: BETA_ID, name: 'Alpha', path: '/Volumes/Field/Alpha', lastOpenedAt: null })],
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getAllByText(/Location: .* · ID ending/u)).toHaveLength(2);
    });
    await userEvent.click(body.getByTestId(`edit-display-name-${OPEN_ID}`));
    const input = body.getByTestId('library-display-name-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'Family archive');
    await userEvent.click(body.getByRole('button', { name: 'Save' }));
    await expect(body.getByTestId('library-row-Family archive')).toBeVisible();
    await expect(args.onCurrentNameChange).toHaveBeenCalledWith('Family archive');

    await userEvent.click(body.getByTestId(`edit-display-name-${OPEN_ID}`));
    await userEvent.click(body.getByTestId('library-display-name-reset'));
    await expect(body.getAllByTestId('library-row-Alpha')).toHaveLength(2);
    await expect(args.onCurrentNameChange).toHaveBeenLastCalledWith('Alpha');
  },
};

export const SwitchAndKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    // Keyboard-only: arrow to Beta from the top row and hit Enter.
    const alpha = body.getByTestId('library-row-Alpha');
    alpha.focus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(body.getByTestId('library-row-Beta')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    // The honest switching screen holds while main tears down + reloads.
    await waitFor(async () => {
      await expect(body.getByTestId('switch-progress')).toBeVisible();
    });
    await expect(body.getByText('Opening Beta…')).toBeVisible();
    await expect(body.getByText(/Closing Alpha/u)).toBeVisible();
  },
};

export const SwitchOnlyWhileLocked: Story = {
  args: { switchOnly: true },
  decorators: [
    (Story) => {
      installStub({
        libraries: LIBRARIES.map((entry) => ({ ...entry, open: false })),
        current: lib({ open: false }),
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await expect(body.queryByTestId('new-library')).toBeNull();
    await expect(body.queryByTestId('add-existing')).toBeNull();
    await expect(body.queryByLabelText('Rename folder of Beta…')).toBeNull();
    await expect(body.queryByLabelText('Edit display name of Beta…')).toBeNull();
    await expect(body.queryByLabelText('Move Beta…')).toBeNull();
    await expect(body.queryByRole('button', { name: 'Remove library from list: Beta' })).toBeNull();
    await userEvent.click(body.getByTestId('library-row-Alpha'));
    await expect(args.onClose).toHaveBeenCalledOnce();
    await userEvent.click(body.getByTestId('library-row-Beta'));
    await expect(body.getByTestId('switch-progress')).toBeVisible();
  },
};

export const RefusalBackupRunning: Story = {
  decorators: [
    (Story) => {
      installStub({ openOutcome: { ok: false, reason: 'provider-busy', host: null } });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await userEvent.click(body.getByTestId('library-row-Beta'));
    // Inline amber banner, never a toast; the list stays workable.
    await waitFor(async () => {
      await expect(body.getByTestId('switch-refusal')).toHaveTextContent("Can't switch while a backup is running");
    });
    await expect(body.getByTestId('library-list')).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Dismiss' }));
    await expect(body.queryByTestId('switch-refusal')).toBeNull();
  },
};

export const RefusalLockedElsewhere: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    // A locked row refuses locally — no IPC round-trip, names the host.
    await userEvent.click(body.getByTestId('library-row-Clara — MacBook'));
    await expect(body.getByTestId('switch-refusal')).toHaveTextContent('This library is open elsewhere');
    await expect(body.getByTestId('switch-refusal')).toHaveTextContent('Locked on CLARAS-MACBOOK');

    // A missing row explains reconnection instead of switching.
    await userEvent.click(body.getByTestId('library-row-ExpeditionX 2026'));
    await expect(body.getByTestId('switch-refusal')).toHaveTextContent("This library's folder is missing");
  },
};

export const SwitchFailureRecovers: Story = {
  decorators: [
    (Story) => {
      installStub({ openRejects: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    // A real IPC failure must NOT wedge the progress screen (PR #450
    // review) — the switcher returns to a fresh list with an error banner.
    await userEvent.click(body.getByTestId('library-row-Beta'));
    await waitFor(async () => {
      await expect(body.getByTestId('switch-refusal')).toHaveTextContent('Something went wrong');
    });
    await expect(body.queryByTestId('switch-progress')).toBeNull();
    await expect(body.getByTestId('library-row-Beta')).toBeVisible();
  },
};

export const RemoveFromList: Story = {
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await userEvent.click(body.getByRole('button', { name: 'Remove library from list: Field Archive' }));
    // Reassurance-forward: green safety copy, neutral (not red) action.
    await expect(body.getByRole('dialog', { name: 'Remove “Field Archive” from this list?' })).toBeVisible();
    await expect(body.getByText('The library files stay on disk and can be opened again.')).toBeVisible();
    const confirm = body.getByTestId('remove-confirm');
    await expect(confirm).not.toHaveClass('ovl-button--danger');
    await userEvent.click(confirm);
    await waitFor(async () => {
      await expect(body.getByRole('dialog', { name: 'Libraries' })).toBeVisible();
    });
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

export const CreateFlow: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await userEvent.click(body.getByTestId('new-library'));
    await expect(body.getByRole('dialog', { name: 'New library' })).toBeVisible();
    const create = body.getByTestId('create-confirm');
    await expect(create).toBeDisabled();
    await expect(body.getByText('App-managed location')).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: 'Choose…' }));
    await waitFor(async () => {
      await expect(body.getByText('/Users/ansel/External/NewHome')).toBeVisible();
    });
    await userEvent.type(body.getByLabelText('Library name'), 'Studio 2026');
    await expect(create).toBeEnabled();
    await userEvent.click(create);
    // Acceptance 1: create hands off to the switch and lands in it.
    await waitFor(async () => {
      await expect(body.getByTestId('switch-progress')).toBeVisible();
    });
    await expect(body.getByText('Opening Studio 2026…')).toBeVisible();
  },
};

export const MoveEntryPointsAndMultiSelect: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    // Per-row Move action exists for movable rows and is absent on blocked
    // ones (missing volume / locked elsewhere) — #483 entry points.
    await expect(body.getByLabelText('Move Alpha…')).toBeVisible();
    await expect(body.queryByLabelText('Move ExpeditionX 2026…')).toBeNull();
    // Multi-select: checking rows reveals the batch action with a count.
    await userEvent.click(body.getByLabelText('Select Alpha to move'));
    await userEvent.click(body.getByLabelText('Select Beta to move'));
    await expect(body.getByTestId('move-selected')).toHaveTextContent('Move 2 selected…');
    // The per-row action opens the wizard's Review step.
    await userEvent.click(body.getByLabelText('Move Beta…'));
    await expect(body.getByRole('dialog', { name: 'Move library' })).toBeVisible();
  },
};
