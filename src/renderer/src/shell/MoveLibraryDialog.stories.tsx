import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { MoveLibraryDialog } from './MoveLibraryDialog';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { LibraryDescriptor } from '../../../shared/library/registry.js';

// #483 / ADR-0022: every wizard state renders and its flow asserts — review
// (destination required, custody assurance, open-library note), sequential
// progress with the commit-aware cancel affordance, and results incl. the
// two-verified-copies cleanup-pending state (acceptance 10). The decorator
// stubs the relocation IPC; real moves round-trip in the E2E lane.

const ALPHA_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const BETA_ID = '01BRZ3NDEKTSV4RRFFQ69G5FAB';
const DESTINATION_AUTHORIZATION = '00000000-0000-4000-8000-000000000001';

function lib(overrides: Partial<LibraryDescriptor>): LibraryDescriptor {
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

type MoveOutcome = Awaited<ReturnType<OverlookApi['libraries']['move']>>;

type ProbeOutcome = Awaited<ReturnType<OverlookApi['libraries']['probeMove']>>;

interface StubOptions {
  readonly moveOutcome?: MoveOutcome | ((id: string) => MoveOutcome);
  readonly movePends?: boolean;
  readonly probeOutcome?: ProbeOutcome | ((id: string) => ProbeOutcome);
  readonly probePends?: boolean;
}

function installStub(options: StubOptions = {}): { readonly calls: string[] } {
  const calls: string[] = [];
  const okOutcome = (destPath: string): MoveOutcome => ({
    ok: true,
    outcome: 'moved',
    mode: 'copy',
    items: 1204,
    bytes: 48_211_890_176,
    sourcePath: '/Users/ansel/Pictures/Overlook/Alpha',
    destPath,
  });
  const libraries = {
    move: ({ id, destPath }: { id: string; destPath: string }) => {
      calls.push(`move:${id}:${destPath}`);
      if (options.movePends === true) return new Promise(() => undefined);
      const outcome = options.moveOutcome;
      if (outcome === undefined) return Promise.resolve(okOutcome(destPath));
      return Promise.resolve(typeof outcome === 'function' ? outcome(id) : outcome);
    },
    cancelMove: ({ id }: { id: string }) => {
      calls.push(`cancel:${id}`);
      return Promise.resolve({ cancelled: true });
    },
    finishMoveCleanup: ({ id }: { id: string }) => {
      calls.push(`cleanup:${id}`);
      return Promise.resolve({ result: 'cleaned' as const });
    },
    probeMove: ({ id }: { id: string }) => {
      calls.push(`probe:${id}`);
      if (options.probePends === true) return new Promise(() => undefined);
      const probe = options.probeOutcome;
      if (probe === undefined) {
        return Promise.resolve({
          ok: true as const,
          mode: 'copy' as const,
          requiredBytes: 48_211_890_176,
          items: 1204,
          freeBytes: 512_000_000_000,
          network: false,
          lockedBy: null,
        });
      }
      return Promise.resolve(typeof probe === 'function' ? probe(id) : probe);
    },
    pendingMoves: () => Promise.resolve({ pending: [] }),
    pickMoveDestination: () => {
      calls.push('pick-move-destination');
      return Promise.resolve({ path: '/Volumes/External/Overlook', authorization: DESTINATION_AUTHORIZATION });
    },
    revokeMoveDestination: () => Promise.resolve({ revoked: true }),
    onMoveProgress: () => () => undefined,
  } as unknown as OverlookApi['libraries'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { libraries };
  return { calls };
}

const meta: Meta<typeof MoveLibraryDialog> = {
  title: 'App/MoveLibraryDialog',
  component: MoveLibraryDialog,
  args: { onClose: fn(), libraries: [lib({})] },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof MoveLibraryDialog>;

export const Review: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('dialog', { name: 'Move library' })).toBeVisible();
    // Custody assurance and the advisory (never a gate — ADR-0022 §5).
    await expect(body.getByText(/original stays in place until every byte/)).toBeVisible();
    await expect(body.getByText(/never required/)).toBeVisible();
    // Primary is disabled until a destination is chosen.
    await expect(body.getByTestId('move-start')).toBeDisabled();
    await userEvent.click(body.getByTestId('move-pick-destination'));
    await waitFor(async () => {
      await expect(body.getByTestId('move-start')).toBeEnabled();
    });
    // Destination preview resolves root + collision-safe folder.
    await expect(body.getByText('→ /Volumes/External/Overlook/Alpha')).toBeVisible();
  },
};

export const ReviewIncludesOpenLibrary: Story = {
  args: { libraries: [lib({ open: true }), lib({ id: BETA_ID, name: 'Beta', path: '/Users/ansel/Pictures/Overlook/Beta' })] },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('dialog', { name: 'Move 2 libraries' })).toBeVisible();
    await expect(body.getByText(/The open library moves last/)).toBeVisible();
  },
};

export const ProgressHoldsWithCancel: Story = {
  decorators: [
    (Story) => {
      installStub({ movePends: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByTestId('move-pick-destination'));
    await waitFor(async () => {
      await expect(body.getByTestId('move-start')).toBeEnabled();
    });
    await userEvent.click(body.getByTestId('move-start'));
    await waitFor(async () => {
      await expect(body.getByTestId('move-progress')).toBeVisible();
    });
    await expect(body.getByText('Library 1 of 1')).toBeVisible();
    // Pre-commit: cancel maps to the engine's rollback.
    await expect(body.getByTestId('move-cancel')).toBeVisible();
  },
};

export const ResultsMovedAndCleanupPending: Story = {
  args: { libraries: [lib({}), lib({ id: BETA_ID, name: 'Beta', path: '/Users/ansel/Pictures/Overlook/Beta' })] },
  decorators: [
    (Story) => {
      installStub({
        moveOutcome: (id) =>
          id === BETA_ID
            ? {
                ok: true,
                outcome: 'moved-cleanup-pending',
                mode: 'copy',
                items: 88,
                bytes: 1_200_000_000,
                sourcePath: '/Users/ansel/Pictures/Overlook/Beta',
                destPath: '/Volumes/External/Overlook/Beta',
              }
            : {
                ok: true,
                outcome: 'moved',
                mode: 'rename',
                items: 1204,
                bytes: 48_211_890_176,
                sourcePath: '/Users/ansel/Pictures/Overlook/Alpha',
                destPath: '/Volumes/External/Overlook/Alpha',
              },
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByTestId('move-pick-destination'));
    await waitFor(async () => {
      await expect(body.getByTestId('move-start')).toBeEnabled();
    });
    await userEvent.click(body.getByTestId('move-start'));
    await waitFor(async () => {
      await expect(body.getByTestId('move-results')).toBeVisible();
    });
    await expect(body.getByText('Moved')).toBeVisible();
    await expect(body.getByText('Instant move', { exact: false })).toBeVisible();
    // Acceptance 10: both verified locations, safe retry, never a guess.
    await expect(body.getByText('Moved — cleanup pending')).toBeVisible();
    await expect(body.getByText(/nothing will be deleted without you/)).toBeVisible();
    await userEvent.click(body.getByTestId('move-finish-cleanup-Beta'));
    await waitFor(async () => {
      await expect(body.queryByText('Moved — cleanup pending')).toBeNull();
    });
  },
};

export const ResultsFailureIsHonest: Story = {
  decorators: [
    (Story) => {
      installStub({
        moveOutcome: { ok: false, reason: 'insufficient-space', detail: 'need 52,000,000,000 bytes free, destination has 9,000,000,000' },
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByTestId('move-pick-destination'));
    await waitFor(async () => {
      await expect(body.getByTestId('move-start')).toBeEnabled();
    });
    await userEvent.click(body.getByTestId('move-start'));
    await waitFor(async () => {
      await expect(body.getByTestId('move-results')).toBeVisible();
    });
    await expect(body.getByText('Failed')).toBeVisible();
    await expect(body.getByText(/Not enough free space/)).toBeVisible();
    await expect(body.getByTestId('move-retry')).toBeVisible();
  },
};

export const ReviewResolvesMethodAndSpace: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByTestId('move-pick-destination'));
    // The dry-run probe resolves the honest method chip and the space meter
    // (ADR-0022 §5 preflight surfaced at Review, per the design handoff).
    await waitFor(async () => {
      await expect(body.getByTestId('move-method-chip')).toBeVisible();
    });
    await expect(body.getByText('Copy & verify')).toBeVisible();
    await expect(body.getByTestId('move-space-meter')).toBeVisible();
    await expect(body.getByText('48.2 GB needed · 512 GB free')).toBeVisible();
    await expect(body.getByTestId('move-start')).toBeEnabled();
  },
};

export const ReviewNetworkWarningNeverBlocks: Story = {
  decorators: [
    (Story) => {
      installStub({
        probeOutcome: { ok: true, mode: 'rename', requiredBytes: 1_000, items: 3, freeBytes: 9_000_000, network: true, lockedBy: null },
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByTestId('move-pick-destination'));
    await waitFor(async () => {
      await expect(body.getByText('Instant move')).toBeVisible();
    });
    // ADR-0017 §5: network destinations warn, never block.
    await expect(body.getByTestId('move-network-warning')).toBeVisible();
    await expect(body.getByTestId('move-start')).toBeEnabled();
  },
};

export const ReviewHoldsStartWhileProbing: Story = {
  decorators: [
    (Story) => {
      installStub({ probePends: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByTestId('move-pick-destination'));
    // A quick click must not outrun the preflight on a slow volume: Start
    // stays disabled until every selected library's probe has resolved.
    await waitFor(async () => {
      await expect(body.getByText('Checking destination…')).toBeVisible();
    });
    await expect(body.getByTestId('move-start')).toBeDisabled();
  },
};

export const ReviewBlocksWhenLockedElsewhere: Story = {
  decorators: [
    (Story) => {
      installStub({
        probeOutcome: {
          ok: true,
          mode: 'copy',
          requiredBytes: 1_000,
          items: 3,
          freeBytes: 9_000_000,
          network: false,
          lockedBy: 'other-machine',
        },
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByTestId('move-pick-destination'));
    // The switcher list can be stale; the probe's lock check is live and
    // blocks Start instead of letting the move fail after the fact.
    await waitFor(async () => {
      await expect(body.getByText('The library is open in another Overlook instance.')).toBeVisible();
    });
    await expect(body.getByTestId('move-start')).toBeDisabled();
  },
};

export const ReviewBlocksOnInsufficientSpace: Story = {
  decorators: [
    (Story) => {
      installStub({
        probeOutcome: { ok: false, reason: 'insufficient-space', detail: 'need 52 GB free, destination has 9 GB' },
      });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByTestId('move-pick-destination'));
    await waitFor(async () => {
      await expect(body.getByText('Not enough free space on the destination.')).toBeVisible();
    });
    await expect(body.getByTestId('move-start')).toBeDisabled();
  },
};
