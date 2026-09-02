import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { appReducer, initialAppState, type AppAction, type AppState } from '../../src/shared/library/app-state.js';
import { EMPTY_PREDICATE, parseSmartPredicate, predicateEquals, type SmartPredicate } from '../../src/shared/library/smart-album.js';

// #514 / ADR-0030 §3: the live facet predicate in app state is the same
// document a Smart Album saves. A plain pick replaces the facet's value, an
// additive pick widens the union, composition is explicit, opening a Smart
// Album loads its query, and leaving one drops it while a live filter stays.

function apply(state: AppState, ...actions: AppAction[]): AppState {
  return actions.reduce(appReducer, state);
}

const SAVED: SmartPredicate = { version: 1, composition: 'or', groups: [{ facet: 'favorite', values: ['yes'] }] };

describe('facet state (#514)', () => {
  test('a plain pick replaces the facet value; an additive pick widens the union; picking the only value again clears it', () => {
    const one = apply(initialAppState, { type: 'facet/toggled', facet: 'camera', value: 'A', additive: false });
    assert.deepEqual(one.facets.groups, [{ facet: 'camera', values: ['A'] }]);
    const replaced = apply(one, { type: 'facet/toggled', facet: 'camera', value: 'B', additive: false });
    assert.deepEqual(replaced.facets.groups, [{ facet: 'camera', values: ['B'] }]);
    const widened = apply(replaced, { type: 'facet/toggled', facet: 'camera', value: 'A', additive: true });
    assert.deepEqual(widened.facets.groups, [{ facet: 'camera', values: ['B', 'A'] }]);
    const narrowed = apply(widened, { type: 'facet/toggled', facet: 'camera', value: 'B', additive: true });
    assert.deepEqual(narrowed.facets.groups, [{ facet: 'camera', values: ['A'] }]);
    const cleared = apply(narrowed, { type: 'facet/toggled', facet: 'camera', value: 'A', additive: false });
    assert.deepEqual(cleared.facets, EMPTY_PREDICATE);
    assert.equal(cleared.selectionMode, 'explicit');
  });

  test('facets keep a stable order, compose explicitly, and every document stays parseable', () => {
    const state = apply(
      initialAppState,
      { type: 'facet/toggled', facet: 'tag', value: 'trip', additive: false },
      { type: 'facet/toggled', facet: 'fileType', value: 'raw', additive: false },
      { type: 'facet/rangeSet', ranges: [{ min: 12, max: null }] },
      { type: 'facetComposition/set', composition: 'or' },
    );
    assert.deepEqual(
      state.facets.groups.map((group) => group.facet),
      ['fileType', 'megapixels', 'tag'],
    );
    assert.equal(state.facets.composition, 'or');
    assert.ok(parseSmartPredicate(JSON.parse(JSON.stringify(state.facets))).ok);
    const withoutSize = apply(state, { type: 'facet/cleared', facet: 'megapixels' });
    assert.deepEqual(
      withoutSize.facets.groups.map((group) => group.facet),
      ['fileType', 'tag'],
    );
    assert.deepEqual(apply(state, { type: 'facet/cleared' }).facets.groups, []);
    assert.equal(apply(state, { type: 'facet/cleared' }).facets.composition, 'or', 'clearing keeps the chosen composition');
  });

  test('opening a Smart Album loads its query over All Photos; leaving it drops the query', () => {
    const inAlbum = apply(initialAppState, { type: 'album/set', albumId: 'A1' }, { type: 'source/set', source: 'favorites' });
    const opened = apply(inAlbum, { type: 'smartAlbum/set', albumId: 'S1', predicate: SAVED });
    assert.equal(opened.smartAlbum, 'S1');
    assert.equal(opened.album, null);
    assert.equal(opened.source, 'all');
    assert.ok(predicateEquals(opened.facets, SAVED));
    const edited = apply(opened, { type: 'facet/toggled', facet: 'camera', value: 'A', additive: false });
    assert.equal(edited.smartAlbum, 'S1', 'editing keeps the album open so the change can be saved');
    assert.equal(apply(edited, { type: 'source/set', source: 'recent' }).smartAlbum, null);
    assert.deepEqual(apply(edited, { type: 'source/set', source: 'recent' }).facets, EMPTY_PREDICATE);
    assert.deepEqual(apply(edited, { type: 'album/set', albumId: 'A1' }).facets, EMPTY_PREDICATE);
    assert.deepEqual(apply(edited, { type: 'protectedAlbum/set', albumId: 'P1' }).facets, EMPTY_PREDICATE);
  });

  test('a live facet filter survives a source change, like the chips do', () => {
    const live = apply(initialAppState, { type: 'facet/toggled', facet: 'camera', value: 'A', additive: false });
    const moved = apply(live, { type: 'source/set', source: 'favorites' });
    assert.deepEqual(moved.facets, live.facets);
    assert.equal(moved.smartAlbum, null);
  });
});
