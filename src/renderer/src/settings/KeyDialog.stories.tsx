import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { KeyDialog } from './KeyDialog';
import type { OverlookApi } from '../../../shared/ipc/api.js';

// #240 exit criteria: the backup form gates export on password strength +
// confirmation + the explicit cannot-be-reset acknowledgment, then shows
// the saved-file card; import gates on file + password and surfaces the
// designed failure copy for a wrong password. The decorator stubs the keys
// IPC — the real crypto round-trips in the unit + E2E lanes.

const FINGERPRINT = '9F2C·4A81·D0E7·5B3A';

function installStub(options?: { readonly importReason?: 'wrong-password' | 'mismatch' | 'invalid' }): void {
  const keys = {
    status: () => Promise.resolve({ fingerprint: FINGERPRINT }),
    export: ({ password }: { password: string }) =>
      Promise.resolve({ path: password === '' ? null : '/Users/ansel/Desktop/overlook-recovery.key' }),
    pickFile: () => Promise.resolve({ path: '/Users/ansel/Desktop/overlook-recovery.key' }),
    import: () =>
      Promise.resolve(
        options?.importReason === undefined
          ? { installed: true, fingerprint: FINGERPRINT, reason: null }
          : { installed: false, fingerprint: null, reason: options.importReason },
      ),
  } as unknown as OverlookApi['keys'];
  (globalThis as { overlook?: Partial<OverlookApi> }).overlook = { keys };
}

const meta: Meta<typeof KeyDialog> = {
  title: 'App/KeyDialog',
  component: KeyDialog,
  args: { open: true, mode: 'backup', onClose: fn() },
  decorators: [
    (Story) => {
      installStub();
      return <Story />;
    },
  ],
};

export default meta;
type Story = StoryObj<typeof KeyDialog>;

export const BackupGating: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('dialog', { name: 'Back up encryption key' })).toBeVisible();
    // Fingerprint row from the keystore.
    await waitFor(async () => {
      await expect(body.getByTestId('key-fingerprint')).toHaveTextContent(FINGERPRINT);
    });
    await expect(body.getByRole('button', { name: 'Copy library key fingerprint' })).toBeVisible();
    const exportButton = body.getByRole('button', { name: 'Export key backup' });
    await expect(exportButton).toBeDisabled();

    // A weak password never enables export, even confirmed + acknowledged.
    await userEvent.type(body.getByLabelText('Encrypt backup with password'), 'abc');
    await expect(body.getByTestId('strength-meter')).toHaveTextContent('Weak');
    await userEvent.type(body.getByLabelText('Confirm password'), 'abc');
    await userEvent.click(body.getByText('I understand this password cannot be reset or recovered.'));
    await expect(exportButton).toBeDisabled();

    // A strong password with a mismatched confirmation stays gated.
    await userEvent.clear(body.getByLabelText('Encrypt backup with password'));
    await userEvent.type(body.getByLabelText('Encrypt backup with password'), 'Correct Horse 9!');
    await expect(body.getByTestId('strength-meter')).toHaveTextContent('Very strong');
    await expect(body.getByRole('alert')).toHaveTextContent("Passwords don't match.");
    await expect(exportButton).toBeDisabled();

    // Matching confirmation + acknowledgment unlocks it; export shows the
    // saved-file card and the store-it-safely warning.
    await userEvent.clear(body.getByLabelText('Confirm password'));
    await userEvent.type(body.getByLabelText('Confirm password'), 'Correct Horse 9!');
    await expect(exportButton).toBeEnabled();
    await userEvent.click(exportButton);
    await waitFor(async () => {
      await expect(body.getByText('Key backup saved.')).toBeVisible();
    });
    await expect(body.getByText('overlook-recovery.key')).toBeVisible();
    await expect(body.getByRole('button', { name: 'Copy recovery key filename' })).toBeVisible();
    await expect(body.getByText(/Keep this file and its password apart/u)).toBeVisible();
    await expect(body.getByRole('button', { name: 'Done' })).toBeVisible();
  },
};

export const ImportFlow: Story = {
  args: { mode: 'import' },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('dialog', { name: 'Import encryption key' })).toBeVisible();
    const importButton = body.getByRole('button', { name: 'Unlock & import' });
    await expect(importButton).toBeDisabled();

    // File via the picker, then the password — both required.
    await userEvent.click(body.getByText('Choose or drop a .key file'));
    await waitFor(async () => {
      await expect(body.getByTestId('key-file-card')).toHaveTextContent('overlook-recovery.key');
    });
    await expect(body.getByRole('button', { name: 'Copy recovery key filename' })).toBeVisible();
    await expect(importButton).toBeDisabled();
    await userEvent.type(body.getByLabelText('Password'), 'Correct Horse 9!');
    await expect(importButton).toBeEnabled();
    await userEvent.click(importButton);
    await waitFor(async () => {
      await expect(body.getByText('Key unlocked and installed.')).toBeVisible();
    });
    await expect(body.getByTestId('key-fingerprint')).toHaveTextContent(FINGERPRINT);
    await expect(body.getByRole('button', { name: 'Copy library key fingerprint' })).toBeVisible();
  },
};

export const ImportWrongPassword: Story = {
  args: { mode: 'import' },
  decorators: [
    (Story) => {
      installStub({ importReason: 'wrong-password' });
      return <Story />;
    },
  ],
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByText('Choose or drop a .key file'));
    await waitFor(async () => {
      await expect(body.getByTestId('key-file-card')).toBeVisible();
    });
    await userEvent.type(body.getByLabelText('Password'), 'nope');
    await userEvent.click(body.getByRole('button', { name: 'Unlock & import' }));
    // The designed failure copy — honest about no-reset, still on the form.
    await waitFor(async () => {
      await expect(body.getByRole('alert')).toHaveTextContent('Wrong password');
    });
    await expect(body.getByRole('button', { name: 'Unlock & import' })).toBeVisible();
  },
};
