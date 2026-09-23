import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePhotoThumbnailUrl } from '../../src/renderer/src/inspector/use-photo-thumbnail-url.js';

let root: Root | undefined;
const previous = window.overlook;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  (window as unknown as { overlook: unknown }).overlook = previous;
  document.body.replaceChildren();
});

test('Inspector reloads repaired thumbnails without changing selection (#1098)', () => {
  let changed = (_event: { photoIds: string[] }): void => {};
  let subscriptions = 0;
  (window as unknown as { overlook: unknown }).overlook = {
    library: {
      onChanged: (listener: typeof changed) => {
        changed = listener;
        subscriptions++;
        return () => {
          changed = () => {};
          subscriptions--;
        };
      },
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  function Thumbnail({ id }: { id: string | null }) {
    return <img src={usePhotoThumbnailUrl(id)} alt="" />;
  }
  const render = (id: string | null) => act(() => root?.render(<Thumbnail id={id} />));
  const src = () => container.querySelector('img')?.getAttribute('src');
  render('first');
  const before = src();
  act(() => changed({ photoIds: ['other'] }));
  assert.equal(src(), before);
  act(() => changed({ photoIds: ['first'] }));
  assert.notEqual(src(), before);
  assert.match(src() ?? '', /first/u);
  const repaired = src();
  render('first');
  assert.equal(src(), repaired, 'ordinary rerenders do not cause image reloads');
  render('second');
  const second = src();
  act(() => changed({ photoIds: ['first'] }));
  assert.equal(src(), second);
  act(() => changed({ photoIds: [] }));
  assert.notEqual(src(), second);
  assert.equal(subscriptions, 1);
  render(null);
  assert.equal(subscriptions, 0);
  render('third');
  act(() => root?.unmount());
  root = undefined;
  assert.equal(subscriptions, 0);
});
