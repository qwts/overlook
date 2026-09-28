import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

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
const DESTINATION_AUTHORIZATION = '00000000-0000-4000-8000-000000000001';

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
      currentLibraries = currentLibraries.filter((entry) => entry.id !== id);
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
    pickMoveDestination: () => Promise.resolve({ path: '/Users/ansel/External/NewHome', authorization: DESTINATION_AUTHORIZATION }),
    revokeMoveDestination: () => Promise.resolve({ revoked: true }),
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
    // Relative time is sans sentence case, never uppercase mono (#1300).
    const when = body.getAllByText(/ ago$/u)[0];
    if (when === undefined) throw new Error('relative time missing');
    await expect(getComputedStyle(when).textTransform).toBe('none');
    await expect(getComputedStyle(when).fontFamily).not.toMatch(/mono/iu);
    // The key hint shows whole or not at all (#1300).
    await expectHintWholeOrHidden(canvasElement.ownerDocument);
    // #1299: each row is the switch plus its ⋯, and nothing else.
    for (const row of canvasElement.ownerDocument.querySelectorAll('.ovl-libswitch__row')) {
      await expect(row.querySelectorAll('button, input, [tabindex]')).toHaveLength(2);
      await expect(row.querySelector('.ovl-libswitch__rowbtn button, .ovl-libswitch__rowbtn input')).toBeNull();
    }
    await expect(body.getByRole('button', { name: 'Actions for Beta' })).toHaveAttribute('aria-haspopup', 'menu');
    await expect(body.getByRole('button', { name: 'Actions for Beta' })).toHaveAttribute('aria-expanded', 'false');
  },
};

// The ⋯ menu for a row, opened from its button.
async function openActions(canvasElement: HTMLElement, name: string): Promise<HTMLElement> {
  const body = within(canvasElement.ownerDocument.body);
  await waitFor(async () => {
    await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
  });
  await userEvent.click(body.getByRole('button', { name: `Actions for ${name}` }));
  return body.getByRole('menu', { name: `Actions for ${name}` });
}

// A menu item's disabled reason, read the way assistive technology reads it.
function reasonOf(item: HTMLElement): string {
  const id = item.getAttribute('aria-describedby');
  return id === null ? '' : (item.ownerDocument.getElementById(id)?.textContent ?? '');
}

// #1299: the open library's menu. Every action is listed in order; Remove is
// disabled with the reason, not hidden. Esc closes the menu only and hands
// focus back to the ⋯ that opened it.
export const MenuOnOpenRow: Story = {
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    const menu = await openActions(canvasElement, 'Alpha');
    await expect(body.getByRole('button', { name: 'Actions for Alpha' })).toHaveAttribute('aria-expanded', 'true');
    const items = within(menu).getAllByRole('menuitem');
    await expect(items.map((item) => item.textContent)).toEqual([
      'Edit display name…',
      'Rename folder…',
      'Move…',
      'Remove library from list…',
    ]);
    await expect(items[0]).toHaveFocus();
    const remove = items[3];
    if (remove === undefined) throw new Error('remove item missing');
    await expect(remove).toHaveAttribute('aria-disabled', 'true');
    await expect(reasonOf(remove)).toBe('This library is open. Switch to another library first.');
    await expect(remove).not.toHaveClass('ovl-context-menu__danger');
    for (const item of items.slice(0, 3)) await expect(item).not.toHaveAttribute('aria-disabled');
    // Disabled items stay reachable by arrow.
    await userEvent.keyboard('{End}');
    await expect(remove).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(body.queryByRole('menu')).toBeNull();
    await expect(body.getByRole('dialog', { name: 'Libraries' })).toBeVisible();
    await expect(body.getByRole('button', { name: 'Actions for Alpha' })).toHaveFocus();
    await expect(args.onClose).not.toHaveBeenCalled();
  },
};

// A missing library can still be renamed for display and removed.
export const MenuOnMissingRow: Story = {
  play: async ({ canvasElement }) => {
    const menu = await openActions(canvasElement, 'ExpeditionX 2026');
    const item = (name: string): HTMLElement => within(menu).getByRole('menuitem', { name });
    await expect(item('Edit display name…')).not.toHaveAttribute('aria-disabled');
    await expect(item('Remove library from list…')).not.toHaveAttribute('aria-disabled');
    for (const name of ['Rename folder…', 'Move…']) {
      await expect(item(name)).toHaveAttribute('aria-disabled', 'true');
      await expect(reasonOf(item(name))).toBe('Reconnect the volume first.');
    }
  },
};

// A library open on another Mac names the host. Shift+F10 on the row opens
// the same menu, and Esc hands focus back to the row.
export const MenuOnElsewhereRow: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    const row = body.getByTestId('library-row-Clara — MacBook');
    row.focus();
    await fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    const menu = body.getByRole('menu', { name: 'Actions for Clara — MacBook' });
    for (const name of ['Rename folder…', 'Move…']) {
      const item = within(menu).getByRole('menuitem', { name });
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(reasonOf(item)).toBe('Close it on CLARAS-MACBOOK first.');
    }
    // Roving is suspended: ↓ moves within the menu, not between rows.
    await userEvent.keyboard('{ArrowDown}');
    await expect(within(menu).getByRole('menuitem', { name: 'Rename folder…' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await expect(body.queryByRole('menu')).toBeNull();
    await expect(row).toHaveFocus();
  },
};

// Right-click and the Menu key open the same menu as the ⋯.
export const RightClickOpensSameMenu: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Beta')).toBeVisible();
    });
    await fireEvent.contextMenu(body.getByTestId('library-row-Beta'), { clientX: 120, clientY: 160 });
    const menu = body.getByRole('menu', { name: 'Actions for Beta' });
    await expect(within(menu).getAllByRole('menuitem')).toHaveLength(4);
    await userEvent.keyboard('{Escape}');
    await fireEvent.keyDown(body.getByTestId('library-row-Beta'), { key: 'ContextMenu' });
    await expect(body.getByRole('menu', { name: 'Actions for Beta' })).toBeVisible();
  },
};

// Where the key hint's text sits against its own clipping box.
function keyHint(doc: Document): { keys: DOMRect; text: DOMRect } {
  const el = doc.querySelector('.ovl-libswitch__keys');
  if (el === null) throw new Error('key hint missing');
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  return { keys: el.getBoundingClientRect(), text: range.getBoundingClientRect() };
}

// Whole on its line, or dropped entirely below the clipped line; never cut.
async function expectHintWholeOrHidden(doc: Document): Promise<void> {
  const { keys, text } = keyHint(doc);
  const whole = text.top >= keys.top && text.bottom <= keys.bottom;
  const hidden = text.top >= keys.bottom;
  await expect(whole || hidden).toBe(true);
}

const narrow: Story['render'] = (args) => (
  <div style={{ position: 'relative', width: 400, height: 560 }}>
    <LibrarySwitcher {...args} />
  </div>
);

// #1300: in a narrow dialog the key hint never wraps; it shows whole where a
// footer line has room or drops below its clipped line, and the buttons stay
// visible.
export const NarrowFooterDropsKeyHint: Story = {
  render: narrow,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await expectHintWholeOrHidden(canvasElement.ownerDocument);
    await expect(body.getByRole('button', { name: /New library/u })).toBeVisible();
    // #1299: the dialog keeps a 16px gutter, and each ⋯ stays on its row.
    await expect(body.getByRole('dialog').getBoundingClientRect().width).toBeLessThanOrEqual(400 - 32);
    for (const row of canvasElement.ownerDocument.querySelectorAll('.ovl-libswitch__row')) {
      const actions = row.querySelector('.ovl-libswitch__actions')?.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      if (actions === undefined) throw new Error('⋯ missing');
      await expect(actions.top).toBeGreaterThanOrEqual(box.top);
      await expect(actions.bottom).toBeLessThanOrEqual(box.bottom);
      await expect(actions.right).toBeLessThanOrEqual(box.right);
    }
  },
};

// Only the hint is clipped: the batch Move button, which wraps to a second
// footer row when narrow, stays visible and hit-testable.
export const NarrowFooterKeepsMoveSelected: Story = {
  render: narrow,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await userEvent.click(body.getByTestId('move-several'));
    await userEvent.click(body.getByRole('checkbox', { name: /^Alpha/u }));
    await userEvent.click(body.getByRole('checkbox', { name: /^Beta/u }));
    const move = body.getByTestId('move-selected');
    await expect(move).toBeVisible();
    const box = move.getBoundingClientRect();
    const hit = move.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    await expect(move.contains(hit)).toBe(true);
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
    // #1299: two libraries named Alpha still get two different ⋯ names.
    const names = body.getAllByRole('button', { name: /^Actions for Alpha/u }).map((button) => button.getAttribute('aria-label'));
    await expect(names).toHaveLength(2);
    await expect(new Set(names).size).toBe(2);
    await expect(names[0]).toMatch(/^Actions for Alpha \(Location: .* · ID ending [0-9A-Z]{4}\)$/u);
    await userEvent.click(body.getByTestId(`library-actions-${OPEN_ID}`));
    await userEvent.click(body.getByRole('menuitem', { name: 'Edit display name…' }));
    const input = body.getByTestId('library-display-name-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'Family archive');
    await userEvent.click(body.getByRole('button', { name: 'Save' }));
    await expect(body.getByTestId('library-row-Family archive')).toBeVisible();
    await expect(args.onCurrentNameChange).toHaveBeenCalledWith('Family archive');
    // Back on the list, focus is on the ⋯ that started it.
    await waitFor(async () => {
      await expect(body.getByTestId(`library-actions-${OPEN_ID}`)).toHaveFocus();
    });

    await userEvent.click(body.getByTestId(`library-actions-${OPEN_ID}`));
    await userEvent.click(body.getByRole('menuitem', { name: 'Edit display name…' }));
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
    await expect(body.queryAllByRole('button', { name: /^Actions for/u })).toHaveLength(0);
    await expect(body.queryByTestId('move-several')).toBeNull();
    await fireEvent.contextMenu(body.getByTestId('library-row-Beta'));
    await expect(body.queryByRole('menu')).toBeNull();
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
    await userEvent.click(body.getByRole('button', { name: 'Actions for Field Archive' }));
    await userEvent.click(body.getByRole('menuitem', { name: 'Remove library from list…' }));
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
    // #1299: the row is gone, the removal is announced, and focus moves to
    // the row that took its place.
    await expect(body.queryByTestId('library-row-Field Archive')).toBeNull();
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Clara — MacBook')).toHaveFocus();
    });
    await waitFor(async () => {
      await expect(body.getByTestId('screen-reader-announcer-polite')).toHaveTextContent(
        'Field Archive removed from this list. Its files were not changed.',
      );
    });
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

// #483 entry points through the ⋯ menu (#1299): Move… is there for every
// row, disabled with the reason where the folder cannot move.
export const MoveFromTheMenu: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const blocked = await openActions(canvasElement, 'ExpeditionX 2026');
    await expect(within(blocked).getByRole('menuitem', { name: 'Move…' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    const menu = await openActions(canvasElement, 'Beta');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Move…' }));
    await expect(body.getByRole('dialog', { name: 'Move library' })).toBeVisible();
  },
};

// Selection mode, nothing checked yet: the rows are checkboxes, the ⋯ are
// gone, and the batch Move stays focusable but disabled with the reason.
export const SelectionModeNoneSelected: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await userEvent.click(body.getByTestId('move-several'));
    await expect(body.getByTestId('move-mode-banner')).toHaveTextContent('Choose libraries to move. The open library moves last.');
    await waitFor(async () => {
      await expect(body.getByRole('checkbox', { name: /^Alpha/u })).toHaveFocus();
    });
    await expect(body.getAllByRole('checkbox')).toHaveLength(5);
    await expect(body.queryAllByRole('button', { name: /^Actions for/u })).toHaveLength(0);
    await expect(body.getByRole('checkbox', { name: /^ExpeditionX 2026/u })).toHaveAttribute('aria-disabled', 'true');
    await expect(body.getByRole('checkbox', { name: /^Clara/u })).toHaveAttribute('aria-disabled', 'true');
    const move = body.getByTestId('move-selected');
    await expect(move).toHaveTextContent('Move 0 selected…');
    await expect(move).toHaveAttribute('aria-disabled', 'true');
    await expect(reasonOf(move)).toBe('Select at least one library');
    await expect(body.getByText('Space select · esc cancel')).toBeVisible();
    await expect(body.queryByTestId('new-library')).toBeNull();
    await waitFor(async () => {
      await expect(body.getByTestId('screen-reader-announcer-polite')).toHaveTextContent(
        'Choose libraries to move. Press Space to select, Escape to cancel.',
      );
    });
    // A blocked row does not check.
    await userEvent.click(body.getByRole('checkbox', { name: /^ExpeditionX 2026/u }));
    await expect(body.getByRole('checkbox', { name: /^ExpeditionX 2026/u })).toHaveAttribute('aria-checked', 'false');
  },
};

// Two checked by keyboard; Esc leaves the mode, a second Esc closes the
// switcher.
export const SelectionModeTwoSelected: Story = {
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await userEvent.click(body.getByTestId('move-several'));
    await waitFor(async () => {
      await expect(body.getByRole('checkbox', { name: /^Alpha/u })).toHaveFocus();
    });
    // The tint means checked only: the open row drops it and keeps its badge.
    const row = (name: string): HTMLElement => {
      const found = body.getByTestId(`library-row-${name}`).closest('li');
      if (found === null) throw new Error(`row ${name} missing`);
      return found;
    };
    await expect(row('Alpha')).not.toHaveClass('ovl-libswitch__row--open');
    await expect(row('Alpha')).not.toHaveClass('ovl-libswitch__row--checked');
    await expect(within(row('Alpha')).getByText('Open now')).toBeVisible();
    // Two footer buttons leave room at 520px: the mode's key hint shows whole.
    const { keys, text } = keyHint(canvasElement.ownerDocument);
    await expect(text.top >= keys.top && text.bottom <= keys.bottom && text.width > 0).toBe(true);
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard(' ');
    await expect(body.getByRole('checkbox', { name: /^Alpha/u })).toHaveAttribute('aria-checked', 'true');
    await expect(body.getByRole('checkbox', { name: /^Beta/u })).toHaveAttribute('aria-checked', 'true');
    await expect(row('Alpha')).toHaveClass('ovl-libswitch__row--checked');
    await expect(row('Beta')).toHaveClass('ovl-libswitch__row--checked');
    await expect(row('Field Archive')).not.toHaveClass('ovl-libswitch__row--checked');
    await expect(getComputedStyle(row('Beta')).backgroundColor).toBe(getComputedStyle(row('Alpha')).backgroundColor);
    await expect(getComputedStyle(row('Beta')).backgroundColor).not.toBe(getComputedStyle(row('Field Archive')).backgroundColor);
    const { keys: keysChecked, text: textChecked } = keyHint(canvasElement.ownerDocument);
    await expect(textChecked.top >= keysChecked.top && textChecked.bottom <= keysChecked.bottom && textChecked.width > 0).toBe(true);
    await expect(body.getByTestId('move-selected')).toHaveTextContent('Move 2 selected…');
    await expect(body.getByTestId('move-selected')).toHaveAttribute('aria-disabled', 'false');
    await waitFor(async () => {
      await expect(body.getByTestId('screen-reader-announcer-polite')).toHaveTextContent('2 selected.');
    });
    await userEvent.keyboard('{Escape}');
    await expect(body.queryByTestId('move-mode-banner')).toBeNull();
    await expect(body.getByRole('dialog', { name: 'Libraries' })).toBeVisible();
    await waitFor(async () => {
      await expect(body.getByTestId('move-several')).toHaveFocus();
    });
    await waitFor(async () => {
      await expect(body.getByTestId('screen-reader-announcer-polite')).toHaveTextContent('Move canceled. Nothing was moved.');
    });
    await expect(args.onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => {
      await expect(args.onClose).toHaveBeenCalledOnce();
    });
  },
};

// Move several → check two → Move: the wizard gets those two, and focus comes
// back to Move several… when it closes.
export const SelectionModeMovesTheChecked: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await userEvent.click(body.getByTestId('move-several'));
    await userEvent.click(body.getByRole('checkbox', { name: /^Beta/u }));
    await userEvent.click(body.getByRole('checkbox', { name: /^Field Archive/u }));
    await userEvent.click(body.getByTestId('move-selected'));
    const wizard = body.getByRole('dialog', { name: /^Move/u });
    await expect(wizard).toHaveTextContent('Beta');
    await expect(wizard).toHaveTextContent('Field Archive');
    await expect(wizard).not.toHaveTextContent('Alpha');
    await userEvent.keyboard('{Escape}');
    await waitFor(async () => {
      await expect(body.getByTestId('move-several')).toHaveFocus();
    });
    await expect(body.queryByTestId('move-mode-banner')).toBeNull();
  },
};

// Every row blocked: nothing can be checked, and focus starts on Cancel.
export const SelectionModeAllBlocked: Story = {
  decorators: [
    (Story) => {
      installStub({ libraries: LIBRARIES.filter((entry) => entry.missing || entry.lockedBy !== null), current: lib({}) });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-ExpeditionX 2026')).toBeVisible();
    });
    await userEvent.click(body.getByTestId('move-several'));
    for (const row of body.getAllByRole('checkbox')) await expect(row).toHaveAttribute('aria-disabled', 'true');
    await waitFor(async () => {
      await expect(body.getByTestId('move-cancel')).toHaveFocus();
    });
    await userEvent.click(body.getAllByRole('checkbox')[0] ?? document.body);
    await expect(body.getByTestId('move-selected')).toHaveTextContent('Move 0 selected…');
  },
};

// One library: there is nothing to move several of.
export const SingleLibraryHasNoMoveSeveral: Story = {
  decorators: [
    (Story) => {
      installStub({ libraries: [lib({ open: true })] });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('library-row-Alpha')).toBeVisible();
    });
    await expect(body.queryByTestId('move-several')).toBeNull();
    // With two footer buttons the key hint has room, and shows whole.
    const { keys, text } = keyHint(canvasElement.ownerDocument);
    await expect(text.top).toBeGreaterThanOrEqual(keys.top);
    await expect(text.bottom).toBeLessThanOrEqual(keys.bottom);
  },
};

// Right to left: the ⋯ sits at the row's inline end, on the left.
export const RtlRows: Story = {
  globals: { locale: 'en-XB' },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(canvasElement.ownerDocument.querySelector('.ovl-libswitch__row')).not.toBeNull();
    });
    const row = canvasElement.ownerDocument.querySelector('.ovl-libswitch__row');
    const actions = row?.querySelector('.ovl-libswitch__actions')?.getBoundingClientRect();
    const rowButton = row?.querySelector('.ovl-libswitch__rowbtn')?.getBoundingClientRect();
    if (actions === undefined || rowButton === undefined) throw new Error('row parts missing');
    await expect(actions.right).toBeLessThanOrEqual(rowButton.left);
    await expect(body.getByRole('dialog')).toBeVisible();
  },
};
