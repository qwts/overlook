import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { createEmbeddingStoryController } from '../../../../.storybook/embedding-story-controller';
import { SemanticIndexSettings, semanticIndexHint } from './SemanticIndexSettings';
import { Field } from './Field';

const controller = createEmbeddingStoryController();

const meta: Meta<typeof SemanticIndexSettings> = {
  title: 'App/Settings/SemanticIndexSettings',
  component: SemanticIndexSettings,
  decorators: [
    (Story) => {
      (globalThis as { overlook?: unknown }).overlook = { embedding: controller.api };
      return (
        <div style={{ maxWidth: 560, padding: 24 }}>
          <Field wide label="Semantic search" hint={semanticIndexHint.defaultMessage}>
            <Story />
          </Field>
        </div>
      );
    },
  ],
};

export default meta;
type Story = StoryObj<typeof SemanticIndexSettings>;

export const ConsentProgressPauseAndResume: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await waitFor(() => canvas.getByRole('switch', { name: 'Enable semantic indexing' }));

    await expect(toggle).not.toBeChecked();
    await expect(canvas.getByText('Downloads a 148 MB on-device model once. Photos and embeddings never leave this device.')).toBeVisible();
    await userEvent.click(toggle);
    await waitFor(() => expect(canvas.getByText('Downloading model… 0%')).toBeVisible());

    controller.advance();
    await waitFor(() => expect(canvas.getByText('Indexing 2 of 10 photos')).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(canvas.getByText('Indexing paused: you paused it')).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(canvas.getByText('Indexing 2 of 10 photos')).toBeVisible());
  },
};
