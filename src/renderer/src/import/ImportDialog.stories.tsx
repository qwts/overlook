import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ImportDialog } from './ImportDialog';
import { defaultSettings, mergeSettings, type AppSettings } from '../../../shared/settings/settings.js';
import type { OverlookApi } from '../../../shared/ipc/api.js';

// #88 exit criteria (sources reworked by #237): pixel/copy match to the
// mock + interaction coverage for the source picker — SD card / no-card
// empty state / folder choose / Dropped — and explicit local Move consent.
// Phase transitions past "options" need the real engine (#90's E2E). The
// decorator stubs window.overlook.settings + import discovery.

const SD_SUMMARY = { total: 1204, newCount: 1204, newBytes: 38_200_000_000, newRaw: 812, newJpg: 392, newOther: 0 };
const FOLDER_SUMMARY = { total: 486, newCount: 486, newBytes: 12_400_000_000, newRaw: 0, newJpg: 486, newOther: 0 };
const DROP_SUMMARY = { total: 2, newCount: 2, newBytes: 61_000_000, newRaw: 1, newJpg: 1, newOther: 0 };
const DRIVE_SUMMARY = { total: 3, newCount: 2, newBytes: 82_000_000, newRaw: 1, newJpg: 1, newOther: 0 };

function installStub(options?: {
  readonly noCard?: boolean;
  readonly importMode?: AppSettings['importMode'];
  readonly folderPaths?: readonly string[];
}): void {
  let current: AppSettings = { ...defaultSettings, importMode: options?.importMode ?? defaultSettings.importMode };
  let folderPick = 0;
  const settingsApi: OverlookApi['settings'] = {
    get: () => Promise.resolve({ settings: current }),
    set: ({ patch }) => {
      current = mergeSettings(current, patch);
      return Promise.resolve({ settings: current });
    },
    onChanged: () => () => undefined,
  };
  const importApi = {
    listSources: () =>
      Promise.resolve({
        sources: options?.noCard === true ? [] : [{ path: '/Volumes/SONY128', label: 'SONY 128GB · A7 IV', kind: 'volume' as const }],
      }),
    scanSource: ({ path }: { path: string }) => Promise.resolve(path === '/Volumes/SONY128' ? SD_SUMMARY : FOLDER_SUMMARY),
    pickFolder: () => {
      const paths = options?.folderPaths ?? ['/Users/ansel/Pictures/Lightroom Exports'];
      const path = paths[Math.min(folderPick, paths.length - 1)] ?? null;
      folderPick += 1;
      return Promise.resolve({ path });
    },
    scanFiles: () => Promise.resolve(DROP_SUMMARY),
    pickGoogleDrive: () =>
      Promise.resolve({
        status: 'ready' as const,
        selectionId: '2b8d4600-b21c-4dea-8c5d-2fef831ea222',
        summary: DRIVE_SUMMARY,
        skipped: 1,
      }),
    cancelGoogleDrivePick: () => Promise.resolve({}),
    runGoogleDrive: () => new Promise(() => undefined),
    discardGoogleDrive: () => Promise.resolve({}),
    pathForFile: () => '',
    run: () => new Promise(() => undefined),
    cancel: () => Promise.resolve({}),
    onScanProgress: () => () => undefined,
    onCopyProgress: () => () => undefined,
    onThumbProgress: () => () => undefined,
  } as unknown as OverlookApi['import'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { settings: settingsApi, import: importApi };
}

const meta: Meta<typeof ImportDialog> = {
  title: 'App/ImportDialog',
  component: ImportDialog,
  args: { open: true, dropped: null, onClose: fn(), onDone: fn() },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof ImportDialog>;

export const SdOptions: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    // The mock's copy, verbatim: mono card line and exact button count.
    await waitFor(async () => {
      await expect(body.getByText('1,204 new · 38.2 GB · 812 RAW / 392 JPG')).toBeVisible();
    });
    await expect(body.getByText('SONY 128GB · A7 IV')).toBeVisible();
    await expect(body.getByRole('button', { name: /Import 1,204 photos/u })).toBeVisible();
    await expect(body.getByText('Generate thumbnails on import')).toBeVisible();
    await expect(body.getByText('Encrypt originals (always on)')).toBeVisible();
    // Copy mode shows no warning; SD keeps Move interactable.
    await expect(body.queryByRole('alert')).toBeNull();
    await expect(body.getByRole('radio', { name: 'Move' })).toBeEnabled();
  },
};

export const MoveWarning: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByRole('radio', { name: 'Move' })).toBeEnabled();
    });
    await userEvent.click(body.getByRole('radio', { name: 'Move' }));
    await expect(body.getByRole('alert')).toHaveTextContent(
      'Each imported original will be deleted from the card only after encrypted custody and decrypt/hash verification.',
    );
    await expect(body.getByRole('checkbox', { name: /I understand verified source files/u })).not.toBeChecked();
    await userEvent.click(body.getByRole('radio', { name: 'Copy' }));
    await expect(body.queryByRole('alert')).toBeNull();
  },
};

export const NoCardEmptyState: Story = {
  decorators: [
    (Story) => {
      installStub({ noCard: true });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByTestId('import-no-card')).toBeVisible();
    });
    await expect(body.getByText('No SD card detected', { selector: '.ovl-import__emptyTitle' })).toBeVisible();
    // Import is unavailable without a source.
    await expect(body.getByRole('button', { name: 'Import' })).toBeDisabled();
    // The empty state's shortcut switches straight to the folder source.
    await userEvent.click(body.getByRole('button', { name: 'Local folder' }));
    await expect(body.getByText('Choose a folder to import')).toBeVisible();
  },
};

export const FolderFlow: Story = {
  decorators: [
    (Story) => {
      installStub({ folderPaths: ['/Users/ansel/Pictures/Lightroom Exports', '/Users/ansel/Pictures/Family'] });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('radio', { name: 'Local folder' }));
    await userEvent.click(body.getByText('Choose a folder to import'));
    // Picked: mono path + scan detail; the footer follows the folder count.
    await waitFor(async () => {
      await expect(body.getByText('/Users/ansel/Pictures/Lightroom Exports')).toBeVisible();
    });
    await expect(body.getByRole('button', { name: 'Copy import source path' })).toBeVisible();
    await expect(body.getByText('486 new · 12.4 GB · 0 RAW / 486 JPG')).toBeVisible();
    await expect(body.getByRole('button', { name: /Import 486 photos/u })).toBeVisible();
    await expect(body.getByRole('radio', { name: 'Move' })).toBeEnabled();
    await userEvent.click(body.getByRole('radio', { name: 'Move' }));
    await expect(body.getByRole('alert')).toHaveTextContent('The folder and unrelated files stay.');
    await expect(body.getByRole('button', { name: /Import 486 photos/u })).toBeDisabled();
    await userEvent.click(body.getByRole('checkbox', { name: /I understand verified source files/u }));
    await expect(body.getByRole('button', { name: /Import 486 photos/u })).toBeEnabled();
    // Clearing returns to the dropzone.
    await userEvent.click(body.getByRole('button', { name: 'Clear folder' }));
    await expect(body.getByText('Choose a folder to import')).toBeVisible();
    await expect(body.getByRole('checkbox', { name: /I understand verified source files/u })).not.toBeChecked();
    await userEvent.click(body.getByText('Choose a folder to import'));
    await waitFor(async () => {
      await expect(body.getByText('/Users/ansel/Pictures/Family')).toBeVisible();
    });
    await expect(body.getByRole('button', { name: 'Copy import source path' })).toBeVisible();
    await expect(body.getByRole('button', { name: /Import 486 photos/u })).toBeDisabled();
  },
};

export const DroppedFiles: Story = {
  args: { dropped: ['/Users/ansel/Desktop/IMG_0001.RAF', '/Users/ansel/Desktop/IMG_0002.JPG'] },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    // Dropped opens pre-selected with its own segment.
    await waitFor(async () => {
      await expect(body.getByText('2 photos ready to import')).toBeVisible();
    });
    await expect(body.getByRole('radio', { name: 'Dropped' })).toBeChecked();
    await expect(body.getByText('2 new · 61 MB · 1 RAW / 1 JPG')).toBeVisible();
    await expect(body.getByRole('button', { name: /Import 2 photos/u })).toBeVisible();
    await expect(body.getByRole('radio', { name: 'Move' })).toBeEnabled();
    await userEvent.click(body.getByRole('radio', { name: 'Move' }));
    await expect(body.getByRole('alert')).toHaveTextContent('Folders and unrelated files stay.');
    await expect(body.getByRole('button', { name: /Import 2 photos/u })).toBeDisabled();
    await userEvent.click(body.getByRole('checkbox', { name: /I understand verified source files/u }));
    await expect(body.getByRole('button', { name: /Import 2 photos/u })).toBeEnabled();
  },
};

export const StoredMoveRequiresFreshConsent: Story = {
  decorators: [
    (Story) => {
      installStub({ importMode: 'move' });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(async () => {
      await expect(body.getByRole('radio', { name: 'Move' })).toBeChecked();
    });
    await expect(body.getByRole('checkbox', { name: /I understand verified source files/u })).not.toBeChecked();
    await expect(body.getByRole('button', { name: /Import 1,204 photos/u })).toBeDisabled();
  },
};

export const GoogleDriveFiles: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('radio', { name: 'Google Drive' }));
    await userEvent.click(body.getByText('Choose photos from Google Drive'));
    await waitFor(async () => {
      await expect(body.getByText('3 photos selected from Google Drive')).toBeVisible();
    });
    await expect(body.getByText('2 new · 82 MB · 1 RAW / 1 JPG')).toBeVisible();
    await expect(body.getByText('1 unsupported or unavailable file skipped')).toBeVisible();
    await expect(body.getByRole('button', { name: /Import 2 photos/u })).toBeVisible();
    await expect(body.getByRole('radio', { name: 'Move' })).toBeDisabled();
    await expect(body.getByText('Imported files are copied — source files are left untouched.')).toBeVisible();
  },
};
