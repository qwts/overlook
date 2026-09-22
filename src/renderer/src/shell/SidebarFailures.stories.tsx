import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import { Sidebar } from './Sidebar';
import type { AlbumListing } from '../../../shared/library/types.js';
import sidebarMeta from './Sidebar.stories';
import { Toast } from '../components/Toast';
import { useAppState } from '../state/app-state-context';

const album: AlbumListing = {
  id: 'a1',
  name: 'Iceland',
  count: 214,
  kind: 'album',
  parentId: null,
  showInAllPhotos: true,
  inheritsVisibility: false,
  visibleElsewhere: 0,
  visibleVia: [],
  tags: [],
  predicate: null,
  unsupported: null,
};

function Feedback() {
  const { toast } = useAppState();
  return toast === null ? null : <Toast title={toast.title} tone={toast.tone} />;
}

const meta: Meta<typeof Sidebar> = {
  ...sidebarMeta,
  title: 'App/Sidebar failures',
  args: { ...sidebarMeta.args, albums: [album] },
  loaders: [
    () => {
      window.localStorage.removeItem('overlook.sidebarCollapsed');
      window.localStorage.removeItem('overlook.albumFoldersCollapsed');
      return Promise.resolve({});
    },
  ],
  render: (args) => (
    <>
      <Sidebar {...args} />
      <Feedback />
    </>
  ),
};
export default meta;
type Story = StoryObj<typeof Sidebar>;

export const CreateRetry: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    let reject: (error: Error) => void = () => undefined;
    const first = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const create = fn(window.overlook.albums.create).mockImplementationOnce(() => first);
    Object.assign(window.overlook.albums, { create });
    const opener = canvas.getByRole('button', { name: 'New album' });
    await userEvent.click(opener);
    const input = canvas.getByRole('textbox', { name: 'Album name' });
    await userEvent.type(input, 'Retry album');
    await userEvent.click(canvas.getByRole('button', { name: /Favorites/u }));
    await expect(input).toHaveValue('Retry album');
    await userEvent.click(opener);
    await expect(input).toHaveFocus();
    await userEvent.keyboard('{Enter}{Enter}{Escape}');
    await expect(create).toHaveBeenCalledTimes(1);
    await expect(input).toHaveValue('Retry album');
    reject(new Error('create failed'));
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      'Could not create Retry album. Press Enter in the name field to retry.',
    );
    await expect(input).toHaveFocus();
    await expect(input).toHaveValue('Retry album');
    create.mockResolvedValueOnce({ album: { ...album, id: 'created', name: 'Retry album', count: 0 } });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.queryByRole('textbox', { name: 'Album name' })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    await expect(create).toHaveBeenNthCalledWith(2, { name: 'Retry album' });
  },
};

async function visibilityRetry(canvasElement: HTMLElement, inherit: boolean): Promise<void> {
  const canvas = within(canvasElement);
  const setVisibility = fn().mockRejectedValueOnce(new Error('visibility failed')).mockResolvedValueOnce({});
  Object.assign(window.overlook.albums, { setVisibility });
  const row = canvas.getByText('Iceland').closest('button');
  if (row === null) throw new Error('missing album row');
  await userEvent.click(row);
  const actions = canvas.getByRole('button', { name: 'Actions for Iceland' });
  const open = async () => {
    actions.focus();
    await waitFor(() => expect(window.getComputedStyle(actions).pointerEvents).toBe('auto'));
    await userEvent.click(actions);
  };
  const name = inherit ? 'Use folder setting' : 'Hide from All Photos';
  await open();
  await userEvent.click(canvas.getByRole('menuitem', { name }));
  await expect(await canvas.findByRole('status')).toHaveTextContent(
    'Could not change visibility for Iceland. Reopen its actions menu to retry.',
  );
  await waitFor(() => expect(actions).toHaveFocus());
  await expect(row).toHaveClass('ovl-siderow--active');
  await expect(setVisibility).toHaveBeenCalledWith({ albumId: 'a1', showInAllPhotos: inherit ? 'inherit' : false });
  await open();
  await userEvent.click(canvas.getByRole('menuitem', { name }));
  await expect(setVisibility).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(actions).toHaveFocus());
  await expect(row).toHaveClass('ovl-siderow--active');
}

export const ExplicitVisibilityRetry: Story = {
  play: async ({ canvasElement }) => visibilityRetry(canvasElement, false),
};

export const InheritedVisibilityRetry: Story = {
  args: {
    albums: [
      { ...album, id: 'folder', name: 'Trips', kind: 'folder' },
      { ...album, parentId: 'folder' },
    ],
  },
  play: async ({ canvasElement }) => visibilityRetry(canvasElement, true),
};
