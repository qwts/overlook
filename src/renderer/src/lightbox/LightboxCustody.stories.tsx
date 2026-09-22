import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';

import type { Lightbox } from './Lightbox';
import lightboxMeta from './Lightbox.stories';

const photo = lightboxMeta.args?.photo;
if (photo === undefined) throw new Error('Lightbox custody story requires the shared photo fixture');
const meta: Meta<typeof Lightbox> = { ...lightboxMeta, title: 'App/Lightbox custody' };
export default meta;
type Story = StoryObj<typeof Lightbox>;

export const LockedExport: Story = {
  args: { photo: { ...photo, locked: true, keyId: 7 } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const action = canvas.getByRole('button', { name: 'Export' });
    await expect(action).toBeDisabled();
    await expect(action).toHaveAttribute('title', 'LOCKED — KEY #7 IS NOT ON THIS DEVICE');
    await userEvent.click(action);
    await expect(args.onExport).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: 'Favorite' }));
    await expect(args.onToggleFavorite).toHaveBeenCalledOnce();
  },
};
