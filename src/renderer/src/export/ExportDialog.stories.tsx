import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { ExportDialog } from './ExportDialog';
import type { OverlookApi } from '../../../shared/ipc/api.js';
import type { PhotoCustodyStatus } from '../../../shared/backup/custody-status.js';
import { DEFAULT_DISCLOSURE_FIELDS } from '../../../shared/disclosure/policy.js';

// #99 exit criteria: copy/pixel match to the mock, switch-off disables the
// button + shows the warning, and phases transition on engine events (the
// decorator installs a stub window.overlook.export that streams progress).

const IDS = ['A', 'B', 'C'];

interface PreflightStub {
  readonly edited: number;
  readonly losses: readonly { photoId: string; fileName: string; reason: string }[];
}

function installStub(custodyFailure?: PhotoCustodyStatus, preflight: PreflightStub = { edited: 0, losses: [] }): void {
  const exportApi: OverlookApi['export'] = {
    preflight: () => Promise.resolve({ edited: preflight.edited, losses: [...preflight.losses] }),
    pickDestination: () => Promise.resolve({ path: '/Users/demo/Exports', authorization: '00000000-0000-4000-8000-000000000001' }),
    revokeDestination: () => Promise.resolve({ revoked: true }),
    runAll: async () => {
      for (let done = 1; done <= IDS.length; done += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        listener?.({ done, total: IDS.length });
      }
      return { exported: IDS.length, failed: 0, cancelled: 0, previewTranscodes: 0, bakedEdits: 0, editSidecars: 0, failures: [] };
    },
    run: async () => {
      for (let done = 1; done <= IDS.length; done += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        listener?.({ done, total: IDS.length });
      }
      return custodyFailure === undefined
        ? { exported: IDS.length, failed: 0, cancelled: 0, previewTranscodes: 1, bakedEdits: 0, editSidecars: 0, failures: [] }
        : {
            exported: IDS.length - 1,
            failed: 1,
            cancelled: 0,
            previewTranscodes: 0,
            bakedEdits: 0,
            editSidecars: 0,
            failures: [{ photoId: IDS[0] ?? 'A', fileName: 'IMG_4021.RAF', reason: 'custody failed', custody: custodyFailure }],
          };
    },
    runBoard: () =>
      Promise.resolve({
        exported: true,
        cancelled: false,
        rendered: IDS.length,
        skipped: 0,
        skippedLocked: 0,
        skippedUnavailable: 0,
        fileName: 'Moodboard.png',
        path: '/Users/demo/Exports/Moodboard.png',
      }),
    cancel: () => Promise.resolve({}),
    onProgress: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  let listener: ((payload: { done: number; total: number }) => void) | null = null;
  const disclosureApi: OverlookApi['disclosure'] = {
    policy: () => Promise.resolve({ policy: { version: 1, fields: DEFAULT_DISCLOSURE_FIELDS }, pinned: [] }),
    setField: () => Promise.reject(new Error('unused')),
    overrides: () => Promise.resolve({ overrides: [] }),
    setOverride: () => Promise.reject(new Error('unused')),
    preview: (request) =>
      Promise.resolve({
        boundary: request.boundary,
        destination: request.destination,
        policyVersion: 1,
        photos: IDS.length,
        fields: [
          {
            field: 'title',
            class: 'shared',
            disclosed: request.destination === 'public' ? 0 : 2,
            withheld: request.destination === 'public' ? 2 : 0,
            present: 2,
            sample: 'Harbour at dusk',
            widened: false,
          },
          {
            field: 'captureTime',
            class: 'shared',
            disclosed: request.destination === 'public' ? 0 : 3,
            withheld: request.destination === 'public' ? 3 : 0,
            present: 3,
            sample: '2026-07-13T10:00:00.000Z',
            widened: false,
          },
          {
            field: 'location',
            class: 'private',
            disclosed: request.operation?.widen.includes('location') === true ? 1 : 0,
            withheld: request.operation?.widen.includes('location') === true ? 0 : 1,
            present: 1,
            sample: '52.37, 4.9',
            widened: request.operation?.widen.includes('location') === true,
          },
        ],
        embedded: request.payload === 'original' ? ['captureTime', 'location'] : [],
        // These stories exercise the export flow, not the gate (DisclosurePreview
        // stories do): only a public destination holds an original back.
        blocked: request.payload === 'original' && request.destination === 'public' ? ['captureTime'] : [],
        retainedSidecars: request.metadata === 'original' ? 1 : 0,
      }),
  };
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { export: exportApi, disclosure: disclosureApi };
}

const meta: Meta<typeof ExportDialog> = {
  title: 'App/ExportDialog',
  component: ExportDialog,
  args: { open: true, photoIds: IDS, onClose: fn() },
  decorators: [
    (Story, context) => {
      installStub(
        context.parameters['custodyFailure'] as PhotoCustodyStatus | undefined,
        context.parameters['preflight'] as PreflightStub | undefined,
      );
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
    await expect(body.getByText('/Users/demo/Exports')).toBeVisible();
    await expect(body.getByRole('button', { name: 'Copy export destination' })).toBeVisible();
    await userEvent.click(body.getByRole('radio', { name: 'Edits' }));
    await expect(body.getByText('Write title, description, and effective tags to a new XMP sidecar.')).toBeVisible();
    await userEvent.click(body.getByRole('radio', { name: 'None' }));
    await expect(body.getByText('Write no metadata sidecars.')).toBeVisible();
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

export const AllUnencrypted: Story = {
  args: { allPhotos: true },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByText('Every photo in this library')).toBeVisible();
    await expect(body.getByText('Unencrypted originals')).toBeVisible();
    await expect(body.queryByRole('switch', { name: 'Decrypt originals' })).toBeNull();
    // #497: Export all declares its payload mode like a selection does.
    await expect(body.getByRole('group', { name: 'Edits' })).toBeVisible();
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await expect(body.getByRole('button', { name: 'Export all photos' })).toBeEnabled();
  },
};

export const ProviderRequiredFailure: Story = {
  parameters: {
    custodyFailure: {
      state: 'provider-required',
      providerId: 'google-drive',
      providerLabel: 'Google Drive',
      accountLabel: 'm.rivera@gmail.com',
    } satisfies PhotoCustodyStatus,
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    await userEvent.click(body.getByRole('button', { name: /Export 3 photos/u }));
    await expect(await body.findByText(/2 exported · 1 failed/u)).toBeVisible();
    await userEvent.click(body.getByText('View item failures'));
    await expect(
      body.getByText(/IMG_4021\.RAF: Google Drive required — reconnect as m\.rivera@gmail\.com to recover this original\./u, {
        selector: '.ovl-copyable-value__text',
      }),
    ).toBeVisible();
  },
};

// #497 (ADR-0031 §6): the preflight names an edit the mode cannot carry; Export
// stays disabled until the user continues with the loss or picks another mode.
export const EditLossReport: Story = {
  parameters: {
    preflight: {
      edited: 2,
      losses: [{ photoId: 'A', fileName: 'IMG_4021.RAF', reason: 'tone-curve v2' }],
    } satisfies PreflightStub,
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: /Choose folder/u }));
    const losses = await body.findByTestId('export-edits-losses');
    await expect(losses).toHaveTextContent('IMG_4021.RAF: tone-curve v2');
    await expect(body.getByRole('button', { name: /Export 3 photos/u })).toBeDisabled();
    await userEvent.click(body.getByRole('switch', { name: 'Continue with these losses' }));
    await expect(body.getByRole('button', { name: /Export 3 photos/u })).toBeEnabled();
    // Original only omits every edit by design: a statement, not a loss to acknowledge.
    await userEvent.click(body.getByRole('radio', { name: 'Original only' }));
    await expect(await body.findByTestId('export-edits-omitted')).toHaveTextContent(
      '2 photos have presentation edits that will not be exported.',
    );
    await expect(body.queryByTestId('export-edits-losses')).toBeNull();
    // Bake shows its explicit quality.
    await userEvent.click(body.getByRole('radio', { name: 'Bake' }));
    await expect(body.getByRole('group', { name: 'JPEG quality' })).toBeVisible();
  },
};
