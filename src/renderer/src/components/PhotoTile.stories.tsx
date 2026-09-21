import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';

import realPhoto from '../../../../design/handoff/assets/thumbs/t01.png';
import { PhotoTile } from './PhotoTile';
import type { SyncState } from './StatusGlyph';

const meta: Meta<typeof PhotoTile> = {
  title: 'Media/PhotoTile',
  component: PhotoTile,
};

export default meta;
type Story = StoryObj<typeof PhotoTile>;

const STATUSES: readonly SyncState[] = ['local', 'synced', 'syncing', 'offloaded', 'error'];

function Matrix(): ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 120px)',
        gap: 'var(--grid-gap)',
        padding: 'var(--space-7)',
      }}
    >
      {STATUSES.map((status) => (
        <div key={status} style={{ aspectRatio: '1' }}>
          <PhotoTile src={realPhoto} alt={status} status={status} onToggleFavorite={fn()} />
        </div>
      ))}
      {STATUSES.map((status) => (
        <div key={`sel-${status}`} style={{ aspectRatio: '1' }}>
          <PhotoTile src={realPhoto} alt={`${status} selected`} status={status} selected favorite onToggleFavorite={fn()} />
        </div>
      ))}
    </div>
  );
}

export const StateMatrix: Story = {
  render: () => <Matrix />,
};

// #548 — video/audio grid tiles: duration pill (playable), PRESERVED pill,
// and kind-iconography placeholders (audio, probing). Grids never move; the
// poster/placeholder never plays inline (ADR-0026 §6/§7).
function VideoTiles(): ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 120px)', gap: 'var(--grid-gap)', padding: 'var(--space-7)' }}>
      <div style={{ aspectRatio: '1' }}>
        <PhotoTile src={realPhoto} alt="Video, 24 seconds, Big Sur" duration={24} onToggleFavorite={fn()} />
      </div>
      <div style={{ aspectRatio: '1' }}>
        <PhotoTile src={realPhoto} alt="Video, 2 minutes 8 seconds" duration={128} onToggleFavorite={fn()} />
      </div>
      <div style={{ aspectRatio: '1' }}>
        {/* No decodable poster → the film fallback stands in (src 404s). */}
        <PhotoTile
          src="data:image/gif;base64,invalid"
          alt="ProRes clip, preserved on this device"
          placeholder="video"
          preserved
          onToggleFavorite={fn()}
        />
      </div>
      <div style={{ aspectRatio: '1' }}>
        <PhotoTile alt="voice-note.mp2, audio" placeholder="audio" onToggleFavorite={fn()} />
      </div>
      <div style={{ aspectRatio: '1' }}>
        <PhotoTile alt="Transport stream, probing" placeholder="probing" onToggleFavorite={fn()} />
      </div>
    </div>
  );
}

export const VideoAndAudioTiles: Story = {
  render: () => <VideoTiles />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Playable video shows a monospace duration; preserved-only reads PRESERVED.
    await expect(canvas.getByText('0:24')).toBeVisible();
    await expect(canvas.getByText('2:08')).toBeVisible();
    await expect(canvas.getByText('PRESERVED')).toBeVisible();
    // No <video>/<audio> element renders in the grid — posters never play inline.
    await expect(canvasElement.querySelector('video')).toBeNull();
    await expect(canvasElement.querySelector('audio')).toBeNull();
    // Regression (#548 §6): the preserved clip's poster src 404s — it's the
    // one img that fails. A `video` tile must fall back to the film glyph (a
    // success state) and NEVER show the still-image "PREVIEW UNAVAILABLE" text;
    // the shipped bug wrote that label into the fallback div, wiping the icon.
    await waitFor(() => expect(canvasElement.querySelector('.ovl-tile__img[data-unavailable="true"]')).not.toBeNull());
    const brokenPoster = canvasElement.querySelector('.ovl-tile__img[data-unavailable="true"]');
    const fallback = brokenPoster?.nextElementSibling;
    await expect(fallback?.classList.contains('ovl-tile__placeholder--fallback')).toBe(true);
    await expect(fallback?.querySelector('svg')).toBeTruthy();
    await expect(fallback?.textContent ?? '').not.toMatch(/UNAVAILABLE/iu);
  },
};

export const ProtectedOriginal: Story = {
  args: {
    src: realPhoto,
    alt: 'IMG_4021.RAF',
    isOriginal: true,
    status: 'synced',
  },
  render: (args) => (
    <div style={{ width: 180, height: 180, padding: 'var(--space-7)', boxSizing: 'content-box' }}>
      <PhotoTile {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('img', { name: 'Protected Original' })).toBeVisible();
  },
};

export const ClickTargetsAreIndependent: Story = {
  args: {
    src: realPhoto,
    alt: 'IMG_4021.RAF',
    status: 'synced',
    onClick: fn(),
    onToggleSelect: fn(),
    favorite: true,
    onToggleFavorite: fn(),
    onContextAction: fn(),
  },
  render: (args) => (
    <div style={{ width: 160, height: 160, padding: 'var(--space-7)', boxSizing: 'content-box' }}>
      <PhotoTile {...args} />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const select = canvas.getByRole('button', { name: 'Select IMG_4021.RAF' });
    await expect(select.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    await expect(select.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    // Circle click selects but never opens.
    await userEvent.click(select);
    await expect(args.onToggleSelect).toHaveBeenCalledOnce();
    await expect(args.onClick).not.toHaveBeenCalled();
    const favorite = canvas.getByRole('button', { name: 'Remove from Favorites' });
    await expect(favorite).toHaveAttribute('aria-pressed', 'true');
    await expect(favorite.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    await expect(favorite.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    await userEvent.click(favorite);
    await expect(args.onToggleFavorite).toHaveBeenCalledOnce();
    await expect(args.onClick).not.toHaveBeenCalled();
    // Tile click opens without toggling selection.
    const openButton = canvas.getByRole('button', { name: 'Open IMG_4021.RAF' });
    const selectButton = canvas.getByRole('button', { name: 'Select IMG_4021.RAF' });
    const status = canvas.getByRole('img', { name: 'Backed up (encrypted)' });
    await expect(openButton).not.toContainElement(selectButton);
    await expect(openButton).not.toContainElement(status);
    await expect(canvas.queryByRole('img', { name: 'IMG_4021.RAF' })).not.toBeInTheDocument();
    await userEvent.click(openButton);
    await expect(args.onClick).toHaveBeenCalledOnce();
    await expect(args.onToggleSelect).toHaveBeenCalledOnce();
    await expect(args.onToggleFavorite).toHaveBeenCalledOnce();

    openButton.focus();
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');
    await expect(args.onClick).toHaveBeenCalledTimes(3);

    await fireEvent.keyDown(openButton, { key: 'F10', shiftKey: true });
    await expect(args.onContextAction).toHaveBeenCalledOnce();
  },
};

export const PreviewUnavailable: Story = {
  args: {
    src: 'data:image/jpeg;base64,AA==',
    alt: 'unsupported.NEF',
  },
  render: (args) => (
    <div style={{ width: 160, height: 160, padding: 'var(--space-7)', boxSizing: 'content-box' }}>
      <PhotoTile {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('PREVIEW UNAVAILABLE'));
    const image = canvasElement.querySelector('img');
    await expect(image).toHaveAttribute('data-unavailable', 'true');

    // A later successful decode clears the direct DOM flag without a React
    // rerender; virtual-grid scroll performance depends on this state-free
    // failure path when many unavailable records enter the viewport.
    if (image !== null) await fireEvent.load(image);
    await expect(image).toHaveAttribute('data-unavailable', 'false');
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument();

    // Leave this named story in its unavailable state so the final visual and
    // accessibility snapshot still exercise the failure UI.
    if (image !== null) await fireEvent.error(image);
    await expect(image).toHaveAttribute('data-unavailable', 'true');
    await expect(canvas.getByRole('status')).toHaveTextContent('PREVIEW UNAVAILABLE');
  },
};

export const UnsupportedHeicCodecIsExplicit: Story = {
  args: {
    src: 'data:image/jpeg;base64,AA==',
    alt: 'unsupported.heic',
    previewFailure: 'unsupported-codec',
  },
  render: (args) => (
    <div style={{ width: 160, height: 160, padding: 'var(--space-7)', boxSizing: 'content-box' }}>
      <PhotoTile {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('PREVIEW UNAVAILABLE — HEIC CODEC IS UNSUPPORTED'));
  },
};

function ReusedTile(): ReactElement {
  const [src, setSrc] = useState('data:image/jpeg;base64,AA==');
  return (
    <div>
      <button type="button" onClick={() => setSrc(realPhoto)}>
        Replace preview
      </button>
      <div style={{ width: 160, height: 160, padding: 'var(--space-7)', boxSizing: 'content-box' }}>
        <PhotoTile src={src} alt="reused tile" />
      </div>
    </div>
  );
}

export const SourceChangeClearsUnavailable: Story = {
  render: () => <ReusedTile />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('PREVIEW UNAVAILABLE'));
    const failedImage = canvasElement.querySelector('img');
    await expect(failedImage).toHaveAttribute('data-unavailable', 'true');

    await userEvent.click(canvas.getByRole('button', { name: 'Replace preview' }));

    const replacementImage = canvasElement.querySelector('img');
    await expect(replacementImage).not.toBe(failedImage);
    await expect(replacementImage).toHaveAttribute('data-unavailable', 'false');
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument();
  },
};

export const DeferredVariantPreviews: Story = {
  ...UnsupportedHeicCodecIsExplicit,
  args: { src: 'data:image/jpeg;base64,AA==', alt: 'deferred variant', previewFailure: 'deferred-original' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('PREVIEWS PENDING — ORIGINAL REQUIRED ON THIS DEVICE'));
  },
};
