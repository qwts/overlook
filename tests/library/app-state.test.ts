import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  appReducer,
  initialAppState,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  type AppAction,
  type AppState,
} from '../../src/shared/library/app-state.js';

function apply(state: AppState, ...actions: AppAction[]): AppState {
  return actions.reduce(appReducer, state);
}

describe('app state reducer', () => {
  test('tracks requested and applied search modes independently', () => {
    const requested = apply(initialAppState, { type: 'searchMode/set', mode: 'semantic' });
    const reported = apply(requested, {
      type: 'search/status',
      search: { requestedMode: 'semantic', appliedMode: 'keyword', fallbackReason: 'indexing', indexed: 4, total: 10 },
    });
    assert.equal(reported.searchMode, 'semantic');
    assert.deepEqual(reported.search, {
      requestedMode: 'semantic',
      appliedMode: 'keyword',
      fallbackReason: 'indexing',
      indexed: 4,
      total: 10,
    });
  });

  test('zoom clamps to the design range', () => {
    assert.equal(initialAppState.zoom, ZOOM_DEFAULT);
    assert.equal(apply(initialAppState, { type: 'zoom/set', zoom: 10 }).zoom, ZOOM_MIN);
    assert.equal(apply(initialAppState, { type: 'zoom/set', zoom: 9999 }).zoom, ZOOM_MAX);
    assert.equal(apply(initialAppState, { type: 'zoom/set', zoom: 200 }).zoom, 200);
  });

  test('thumbs/invalidated bumps only the named ids, so exactly their tiles refetch (#548 §6)', () => {
    assert.deepEqual(initialAppState.thumbEpoch, {});
    const first = apply(initialAppState, { type: 'thumbs/invalidated', photoIds: ['a', 'b'] });
    assert.deepEqual(first.thumbEpoch, { a: 1, b: 1 });
    // A second change to `a` alone advances only `a`; `b` keeps its cached image.
    const second = apply(first, { type: 'thumbs/invalidated', photoIds: ['a'] });
    assert.deepEqual(second.thumbEpoch, { a: 2, b: 1 });
    // An empty list is a no-op and preserves referential identity.
    assert.equal(apply(second, { type: 'thumbs/invalidated', photoIds: [] }), second);
  });

  test('metadata responses patch only named records without resetting selection or scroll state (#508)', () => {
    const photo = (id: string, title: string | null) => ({ id, title }) as AppState['photos'][number];
    const loaded = apply(
      initialAppState,
      { type: 'photos/loaded', photos: [photo('a', null), photo('b', null)], append: false },
      { type: 'selection/all', photoIds: ['a'] },
    );
    const patched = apply(loaded, { type: 'photos/records-patched', photos: [photo('a', 'Authored')] });
    assert.equal(patched.photos[0]?.title, 'Authored');
    assert.equal(patched.photos[1], loaded.photos[1]);
    assert.deepEqual([...patched.selection], ['a']);
    assert.equal(patched.selection, loaded.selection, 'unrelated record patches preserve the memoized Inspector selection scope');
  });

  test('view switches across grid, list, and moodboard (#515)', () => {
    assert.equal(initialAppState.view, 'grid');
    assert.equal(apply(initialAppState, { type: 'view/set', view: 'moodboard' }).view, 'moodboard');
    assert.equal(apply(initialAppState, { type: 'view/set', view: 'list' }).view, 'list');
  });

  test('sidebar visibility toggles from the View menu (#689)', () => {
    assert.equal(initialAppState.sidebarOpen, true);
    const hidden = apply(initialAppState, { type: 'sidebar/toggled' });
    assert.equal(hidden.sidebarOpen, false);
    assert.equal(apply(hidden, { type: 'sidebar/toggled' }).sidebarOpen, true);
  });

  test('selection toggles, selects all, clears', () => {
    let state = apply(initialAppState, { type: 'selection/toggled', photoId: 'a' }, { type: 'selection/toggled', photoId: 'b' });
    assert.deepEqual([...state.selection].sort(), ['a', 'b']);
    state = apply(state, { type: 'selection/toggled', photoId: 'a' });
    assert.deepEqual([...state.selection], ['b']);
    state = apply(state, { type: 'selection/all', photoIds: ['x', 'y', 'z'] });
    assert.equal(state.selection.size, 3);
    state = apply(state, { type: 'selection/cleared' });
    assert.equal(state.selection.size, 0);
  });

  test('selection survives filter changes only for still-visible items (#78)', () => {
    const b = { id: 'b' } as AppState['photos'][number];
    const c = { id: 'c' } as AppState['photos'][number];
    const selected = apply(initialAppState, { type: 'selection/all', photoIds: ['a', 'b'] });
    // Switching source/chips keeps the selection until the new page lands…
    const switched = apply(selected, { type: 'source/set', source: 'favorites' }, { type: 'chip/toggled', chip: 'raw' });
    assert.equal(switched.selection.size, 2);
    assert.equal(switched.chips.raw, true);
    assert.equal(apply(switched, { type: 'chip/toggled', chip: 'raw' }).chips.raw, false);
    // …then intersects with the freshly visible set: b stays, a drops.
    const landed = apply(switched, { type: 'photos/loaded', photos: [b, c], append: false });
    assert.deepEqual([...landed.selection], ['b']);
    // Appending pages never trims the selection.
    const appended = apply(landed, { type: 'photos/loaded', photos: [{ id: 'd' } as AppState['photos'][number]], append: true });
    assert.deepEqual([...appended.selection], ['b']);
  });

  test('complete Select All survives page replacement until the collection changes', () => {
    const selected = apply(initialAppState, { type: 'selection/all', photoIds: ['a', 'b', 'c'] });
    const refreshed = apply(selected, { type: 'photos/loaded', photos: [{ id: 'a' } as AppState['photos'][number]], append: false });
    assert.deepEqual([...refreshed.selection].sort(), ['a', 'b', 'c']);
    const switched = apply(refreshed, { type: 'source/set', source: 'favorites' });
    const landed = apply(switched, { type: 'photos/loaded', photos: [{ id: 'b' } as AppState['photos'][number]], append: false });
    assert.deepEqual([...landed.selection], ['b']);
  });

  test('complete Select All survives sort changes', () => {
    const selected = apply(initialAppState, { type: 'selection/all', photoIds: ['a', 'b', 'c'] });
    const sorted = apply(selected, { type: 'sortOrder/set', order: 'name' });
    const refreshed = apply(sorted, { type: 'photos/loaded', photos: [{ id: 'c' } as AppState['photos'][number]], append: false });
    assert.equal(refreshed.selectionMode, 'all');
    assert.deepEqual([...refreshed.selection].sort(), ['a', 'b', 'c']);
  });

  test('refining complete Select All preserves unloaded ids across page replacement', () => {
    const selected = apply(initialAppState, { type: 'selection/all', photoIds: ['a', 'b', 'c'] });
    const refined = apply(selected, { type: 'selection/toggled', photoId: 'b' });
    const refreshed = apply(refined, {
      type: 'photos/loaded',
      photos: [{ id: 'a' } as AppState['photos'][number]],
      append: false,
    });
    assert.equal(refreshed.selectionMode, 'all');
    assert.deepEqual([...refreshed.selection].sort(), ['a', 'c']);
  });

  test('mutation refresh clears complete selection and advances selection intent', () => {
    const selected = apply(initialAppState, { type: 'selection/all', photoIds: ['a', 'b'] });
    const cleared = apply(selected, {
      type: 'photos/loaded',
      photos: [{ id: 'a' } as AppState['photos'][number]],
      append: false,
      invalidateCompleteSelection: true,
    });
    assert.equal(cleared.selection.size, 0);
    assert.equal(cleared.selectionMode, 'explicit');
    assert.equal(cleared.selectionRevision, selected.selectionRevision + 1);
    const emptyClear = apply(cleared, { type: 'selection/cleared' });
    assert.equal(emptyClear.selectionRevision, cleared.selectionRevision + 1);
  });

  test('membership refresh intersects explicit selection without clearing surviving ids', () => {
    const photos = ['a', 'b', 'c'].map((id) => ({ id }) as AppState['photos'][number]);
    const selected = apply(
      initialAppState,
      { type: 'photos/loaded', photos, append: false },
      { type: 'selection/toggled', photoId: 'a' },
      { type: 'selection/toggled', photoId: 'b' },
    );
    const refreshed = apply(selected, {
      type: 'photos/loaded',
      photos: [photos[0]!, photos[2]!],
      append: false,
      invalidateCompleteSelection: true,
    });
    assert.deepEqual([...refreshed.selection], ['a']);
    assert.equal(refreshed.selectionRevision, selected.selectionRevision);
  });

  test('escape exits the lightbox when open, otherwise clears selection', () => {
    const withBoth = apply(initialAppState, { type: 'selection/all', photoIds: ['a'] }, { type: 'lightbox/opened', photoId: 'a' });
    const afterFirst = apply(withBoth, { type: 'escape' });
    assert.equal(afterFirst.lightboxId, null);
    assert.equal(afterFirst.selection.size, 1, 'selection survives the lightbox exit');
    const afterSecond = apply(afterFirst, { type: 'escape' });
    assert.equal(afterSecond.selection.size, 0);
    assert.equal(afterSecond.selectionRevision, afterFirst.selectionRevision + 1);
  });

  test('opening a shell dialog is exclusive while closing one preserves the active dialog (#486)', () => {
    const importing = apply(initialAppState, { type: 'dialog/set', dialog: 'import', open: true });
    const settings = apply(importing, { type: 'dialog/set', dialog: 'settings', open: true });
    const state = apply(settings, { type: 'dialog/set', dialog: 'import', open: false });
    assert.equal(importing.importOpen, true);
    assert.equal(settings.importOpen, false);
    assert.deepEqual(
      { importOpen: state.importOpen, exportOpen: state.exportOpen, settingsOpen: state.settingsOpen },
      { importOpen: false, exportOpen: false, settingsOpen: true },
    );
  });

  test('photo pages replace or append', () => {
    const a = { id: 'a' } as AppState['photos'][number];
    const b = { id: 'b' } as AppState['photos'][number];
    const loaded = apply(initialAppState, { type: 'photos/loaded', photos: [a], append: false });
    assert.equal(loaded.photos.length, 1);
    const appended = apply(loaded, { type: 'photos/loaded', photos: [b], append: true });
    assert.deepEqual(
      appended.photos.map((photo) => photo.id),
      ['a', 'b'],
    );
    const replaced = apply(appended, { type: 'photos/loaded', photos: [b], append: false });
    assert.deepEqual(
      replaced.photos.map((photo) => photo.id),
      ['b'],
    );
  });

  test('protected routes cannot retain ordinary photos, selection, lightbox, or inspector state (#329)', () => {
    const ordinary = { id: 'ordinary-photo' } as AppState['photos'][number];
    const loaded = apply(
      initialAppState,
      { type: 'photos/loaded', photos: [ordinary], append: false },
      { type: 'selection/all', photoIds: [ordinary.id] },
      { type: 'lightbox/opened', photoId: ordinary.id },
      { type: 'inspector/toggled' },
    );
    const protectedRoute = apply(loaded, { type: 'protectedAlbum/set', albumId: 'opaque-protected-id' });
    assert.equal(protectedRoute.protectedAlbum, 'opaque-protected-id');
    assert.deepEqual(protectedRoute.photos, []);
    assert.equal(protectedRoute.selection.size, 0);
    assert.equal(protectedRoute.lightboxId, null);
    assert.equal(protectedRoute.inspectorOpen, false);
    assert.equal(apply(protectedRoute, { type: 'source/set', source: 'favorites' }).protectedAlbum, null);
    assert.equal(apply(protectedRoute, { type: 'album/set', albumId: 'ordinary-album' }).protectedAlbum, null);
  });

  test('1,500 backup status patches preserve the loaded gallery, selection, and lightbox (#295)', () => {
    const photos = Array.from(
      { length: 1_500 },
      (_, index) => ({ id: `photo-${String(index)}`, syncState: 'local' }) as AppState['photos'][number],
    );
    const loaded = apply(
      initialAppState,
      { type: 'photos/loaded', photos, append: false },
      { type: 'selection/all', photoIds: ['photo-1200', 'photo-1499'] },
      { type: 'lightbox/opened', photoId: 'photo-1200' },
    );

    const patched = apply(loaded, {
      type: 'photos/sync-state-patched',
      updates: photos.map((photo) => ({ id: photo.id, syncState: 'synced' })),
    });

    assert.equal(patched.photos.length, 1_500);
    assert.ok(patched.photos.every((photo) => photo.syncState === 'synced'));
    assert.deepEqual([...patched.selection], ['photo-1200', 'photo-1499']);
    assert.equal(patched.lightboxId, 'photo-1200');
  });

  test('pendingCount and backup label track IPC pushes', () => {
    const state = apply(initialAppState, { type: 'pendingCount/set', count: 42 }, { type: 'backupLabel/set', label: 'JUST NOW' });
    assert.equal(state.pendingCount, 42);
    assert.equal(state.lastBackupLabel, 'JUST NOW');
  });

  test('providerConnected mirrors the settings push (#239)', () => {
    assert.equal(initialAppState.providerConnected, true);
    const off = apply(initialAppState, { type: 'providerConnected/set', connected: false });
    assert.equal(off.providerConnected, false);
    const on = apply(off, { type: 'providerConnected/set', connected: true });
    assert.equal(on.providerConnected, true);
    const selected = apply(on, { type: 'provider/set', connected: false, label: 'Future Cloud' });
    assert.equal(selected.providerConnected, false);
    assert.equal(selected.providerLabel, 'Future Cloud');
  });

  test('query, view, explicit lightbox close, and toast lifecycle', () => {
    let state = apply(
      initialAppState,
      { type: 'query/set', query: 'kyoto' },
      { type: 'view/set', view: 'list' },
      { type: 'lightbox/opened', photoId: 'a' },
      { type: 'lightbox/closed' },
      { type: 'toast/shown', toast: { title: 'EXPORTED', tone: 'green' } },
    );
    assert.equal(state.query, 'kyoto');
    assert.equal(state.view, 'list');
    assert.equal(state.lightboxId, null);
    assert.equal(state.toast?.title, 'EXPORTED');
    state = apply(state, { type: 'toast/dismissed' });
    assert.equal(state.toast, null);
  });

  test('lightbox owns and closes the Inspector it opened (#503)', () => {
    const photo = { id: 'a' } as AppState['photos'][number];
    const open = apply(
      initialAppState,
      { type: 'photos/loaded', photos: [photo], append: false },
      { type: 'lightbox/opened', photoId: photo.id },
      { type: 'inspector/toggled' },
    );
    assert.equal(open.inspectorOpen, true);
    assert.equal(open.inspectorSource, 'lightbox');
    assert.equal(open.inspectorPhotoId, photo.id);

    const closed = apply(open, { type: 'lightbox/closed' });
    assert.equal(closed.lightboxId, null);
    assert.equal(closed.inspectorOpen, false);
    assert.equal(closed.inspectorSource, null);
    assert.equal(closed.inspectorPhotoId, null);
  });

  test('Inspector pages a multi-selection in stable visible order (#503)', () => {
    const photos = ['a', 'b', 'c'].map((id) => ({ id }) as AppState['photos'][number]);
    let state = apply(
      initialAppState,
      { type: 'photos/loaded', photos, append: false },
      { type: 'selection/all', photoIds: ['c', 'a'] },
      { type: 'inspector/toggled' },
    );
    assert.equal(state.inspectorSource, 'selection');
    assert.equal(state.inspectorPhotoId, 'a', 'visible gallery order wins over set insertion order');
    state = apply(state, { type: 'inspector/stepped', delta: 1 });
    assert.equal(state.inspectorPhotoId, 'c');
    state = apply(state, { type: 'inspector/stepped', delta: 1 });
    assert.equal(state.inspectorPhotoId, 'a', 'cursor wraps');

    state = apply(state, { type: 'selection/toggled', photoId: 'a' });
    assert.equal(state.inspectorPhotoId, 'c', 'removing the focused item chooses the next visible selection');
    state = apply(state, { type: 'photos/loaded', photos: [photos[0]!], append: false });
    assert.equal(state.inspectorPhotoId, null);
    assert.equal(state.inspectorOpen, true, 'an empty grid selection keeps the explicitly opened dock available');
  });

  test('detached Inspector follows lightbox focus then falls back to gallery selection (#503)', () => {
    const photos = ['a', 'b'].map((id) => ({ id }) as AppState['photos'][number]);
    let state = apply(
      initialAppState,
      { type: 'photos/loaded', photos, append: false },
      { type: 'selection/all', photoIds: ['a'] },
      { type: 'lightbox/opened', photoId: 'b' },
      { type: 'inspector/detached' },
    );
    assert.equal(state.inspectorDetached, true);
    assert.equal(state.inspectorOpen, false);
    assert.equal(state.inspectorSource, 'lightbox');
    assert.equal(state.inspectorPhotoId, 'b');

    state = apply(state, { type: 'lightbox/closed' });
    assert.equal(state.inspectorDetached, true);
    assert.equal(state.inspectorSource, 'selection');
    assert.equal(state.inspectorPhotoId, 'a');

    state = apply(state, { type: 'inspector/toggled' });
    assert.equal(state.inspectorDetached, false);
    assert.equal(state.inspectorOpen, true, 'showing the dock reattaches the same Inspector authority');
    state = apply(state, { type: 'inspector/detached' }, { type: 'inspector/detached-closed' });
    assert.equal(state.inspectorDetached, false);
    assert.equal(state.inspectorSource, null);
    assert.equal(state.inspectorPhotoId, null);
  });

  test('Inspector lifecycle preserves reducer no-ops and alternate close paths (#503)', () => {
    const photos = ['a', 'b'].map((id) => ({ id }) as AppState['photos'][number]);
    const sorted = apply(initialAppState, { type: 'sortOrder/set', order: 'name' });
    assert.equal(sorted.sortOrder, 'name');
    const invalidLightbox = { ...sorted, photos, lightboxId: 'missing' };
    assert.equal(apply(invalidLightbox, { type: 'lightbox/stepped', delta: 1 }), invalidLightbox);

    const docked = apply(sorted, { type: 'photos/loaded', photos, append: false }, { type: 'inspector/toggled' });
    const hidden = apply(docked, { type: 'inspector/toggled' });
    assert.equal(hidden.inspectorOpen, false);
    assert.equal(hidden.inspectorSource, null);

    const detached = apply(
      sorted,
      { type: 'photos/loaded', photos, append: false },
      { type: 'selection/all', photoIds: ['a'] },
      { type: 'lightbox/opened', photoId: 'b' },
      { type: 'inspector/detached' },
      { type: 'escape' },
    );
    assert.equal(detached.lightboxId, null);
    assert.equal(detached.inspectorSource, 'selection');
    assert.equal(detached.inspectorPhotoId, 'a');
  });

  test('lightbox follows visibility: an id that leaves the photo set closes for real (#92)', () => {
    const photo = (id: string) => ({ id }) as AppState['photos'][number];
    let state = apply(
      initialAppState,
      { type: 'photos/loaded', photos: [photo('a'), photo('b')], append: false },
      { type: 'lightbox/opened', photoId: 'a' },
    );
    // A refetch still containing the photo keeps the lightbox open...
    state = apply(state, { type: 'photos/loaded', photos: [photo('a')], append: false });
    assert.equal(state.lightboxId, 'a');
    // ...but one without it clears the id — no spurious reopen later.
    state = apply(state, { type: 'photos/loaded', photos: [photo('b')], append: false });
    assert.equal(state.lightboxId, null);
  });

  test('lightbox/stepped walks the visible sequence with wraparound (#93)', () => {
    const photo = (id: string) => ({ id }) as AppState['photos'][number];
    // A closed lightbox ignores steps.
    const closed = apply(initialAppState, { type: 'photos/loaded', photos: [photo('a'), photo('b')], append: false });
    assert.equal(apply(closed, { type: 'lightbox/stepped', delta: 1 }).lightboxId, null);

    let state = apply(closed, { type: 'lightbox/opened', photoId: 'a' });
    state = apply(state, { type: 'lightbox/stepped', delta: 1 });
    assert.equal(state.lightboxId, 'b');
    // Forward off the end wraps to the start; backward from the start wraps
    // to the end.
    state = apply(state, { type: 'lightbox/stepped', delta: 1 });
    assert.equal(state.lightboxId, 'a');
    state = apply(state, { type: 'lightbox/stepped', delta: -1 });
    assert.equal(state.lightboxId, 'b');
  });

  test('import-completion toast carries its serializable Show action (#89)', () => {
    const state = apply(initialAppState, {
      type: 'toast/shown',
      toast: { title: 'Imported 1,204 photos', tone: 'green', action: 'show-recent' },
    });
    assert.equal(state.toast?.action, 'show-recent');
    // The Show jump is a plain source/set — reducer semantics unchanged.
    const jumped = apply(state, { type: 'source/set', source: 'recent' }, { type: 'toast/dismissed' });
    assert.equal(jumped.source, 'recent');
    assert.equal(jumped.toast, null);
  });

  test('offload Undo toast preserves the exact photo ids (#281)', () => {
    const state = apply(initialAppState, {
      type: 'toast/shown',
      toast: { title: 'Offloaded 2', tone: 'green', action: 'undo-offload', actionPhotoIds: ['a', 'b'] },
    });
    assert.equal(state.toast?.action, 'undo-offload');
    assert.deepEqual(state.toast?.actionPhotoIds, ['a', 'b']);
  });
});
