import {
  EMPTY_PREDICATE,
  clearFacet,
  setComposition,
  setMegapixelRanges,
  toggleFacetValue,
  type FacetComposition,
  type FacetId,
  type MegapixelRange,
  type SmartPredicate,
} from './smart-album.js';
import type { ChipFilters, PageResult, PhotoRecord, SearchMode, SortOrder, SourceFilter } from './types.js';

// App state backbone (#73) — the mock's state shape as a pure reducer, kept
// process-free so the unit lane floors it. The renderer provides it via
// context; IPC push events dispatch into it.

export type ViewMode = 'grid' | 'list' | 'feed' | 'moodboard';

export const ZOOM_MIN = 96;
export const ZOOM_MAX = 320;
export const ZOOM_DEFAULT = 160;

export interface AppState {
  readonly photos: readonly PhotoRecord[];
  /** Per-photo cache-bust counter for the thumb/poster URL. A derivative can be
   * regenerated in place (a video poster captured after import, a RAW preview
   * repaired) without the record — and hence its stable thumb URL — changing,
   * so an already-loaded <img> would never refetch. Bumping this on the
   * library:changed ids appends a fresh query token, forcing exactly those
   * tiles to reload without a navigation. */
  readonly thumbEpoch: Readonly<Record<string, number>>;
  readonly query: string;
  readonly searchMode: SearchMode;
  readonly search: PageResult['search'];
  readonly zoom: number;
  readonly view: ViewMode;
  readonly source: SourceFilter;
  readonly chips: ChipFilters;
  /** Mirrors the settings store's sortOrder (#113); the grid query reads it. */
  readonly sortOrder: SortOrder;
  /** Active album filter (#117) — an album acts as a source; null = none. */
  readonly album: string | null;
  /** Live facet predicate (#514, ADR-0030 §3) — the same document a Smart
   * Album saves. Empty groups = no facet filter. */
  readonly facets: SmartPredicate;
  /** The Smart Album whose saved query `facets` started from; null when the
   * facets are a live filter over a source. */
  readonly smartAlbum: string | null;
  /** Independent protected-domain route. Ordinary photo records are cleared
   * before this is set and never represent protected content. */
  readonly protectedAlbum: string | null;
  readonly selection: ReadonlySet<string>;
  /** `all` selections span unloaded pages and survive page replacement. */
  readonly selectionMode: 'explicit' | 'all';
  /** Increments for every selection intent, including clearing an empty set. */
  readonly selectionRevision: number;
  readonly lightboxId: string | null;
  readonly inspectorOpen: boolean;
  /** Sidebar visibility — toggled from View → Toggle Sidebar (#689). */
  readonly sidebarOpen: boolean;
  readonly inspectorDetached: boolean;
  /** The surface that owns the docked Inspector lifecycle. */
  readonly inspectorSource: 'lightbox' | 'selection' | null;
  /** Stable cursor for paging through the visible selection. */
  readonly inspectorPhotoId: string | null;
  readonly importOpen: boolean;
  readonly exportOpen: boolean;
  readonly settingsOpen: boolean;
  readonly activityOpen: boolean;
  readonly librariesOpen: boolean;
  readonly toast: {
    readonly title: string;
    readonly tone: 'neutral' | 'green' | 'amber' | 'red';
    /** Serializable action marker — the shell maps it to a handler (#89). */
    readonly action?: 'show-recent' | 'retry-backup' | 'undo-offload' | undefined;
    readonly actionPhotoIds?: readonly string[] | undefined;
  } | null;
  readonly pendingCount: number;
  readonly lastBackupLabel: string;
  /** Mirrors settings.providerId !== null (#239): disconnected hides every
   * selected-provider surface (toolbar backup, status-bar sync, sidebar progress). */
  readonly providerConnected: boolean;
  /** Descriptor-driven label for the selected/default backup provider. */
  readonly providerLabel: string;
}

export const initialAppState: AppState = {
  photos: [],
  thumbEpoch: {},
  query: '',
  searchMode: 'auto',
  search: { requestedMode: 'auto', appliedMode: 'keyword', fallbackReason: null, indexed: 0, total: 0 },
  zoom: ZOOM_DEFAULT,
  view: 'grid',
  source: 'all',
  chips: {},
  sortOrder: 'date',
  album: null,
  facets: EMPTY_PREDICATE,
  smartAlbum: null,
  protectedAlbum: null,
  selection: new Set<string>(),
  selectionMode: 'explicit',
  selectionRevision: 0,
  lightboxId: null,
  inspectorOpen: false,
  sidebarOpen: true,
  inspectorDetached: false,
  inspectorSource: null,
  inspectorPhotoId: null,
  importOpen: false,
  exportOpen: false,
  settingsOpen: false,
  activityOpen: false,
  librariesOpen: false,
  toast: null,
  pendingCount: 0,
  lastBackupLabel: '2H AGO',
  providerConnected: true,
  providerLabel: 'Cloud',
};

export type AppAction =
  | { type: 'photos/loaded'; photos: readonly PhotoRecord[]; append: boolean; invalidateCompleteSelection?: boolean }
  | { type: 'photos/records-patched'; photos: readonly PhotoRecord[] }
  | {
      type: 'photos/sync-state-patched';
      updates: readonly { readonly id: string; readonly syncState: PhotoRecord['syncState'] }[];
    }
  | { type: 'thumbs/invalidated'; photoIds: readonly string[] }
  | { type: 'query/set'; query: string }
  | { type: 'searchMode/set'; mode: SearchMode }
  | { type: 'search/status'; search: PageResult['search'] }
  | { type: 'zoom/set'; zoom: number }
  | { type: 'view/set'; view: ViewMode }
  | { type: 'source/set'; source: SourceFilter }
  | { type: 'chip/toggled'; chip: keyof ChipFilters }
  | { type: 'sortOrder/set'; order: SortOrder }
  | { type: 'album/set'; albumId: string | null }
  | { type: 'facet/toggled'; facet: Exclude<FacetId, 'megapixels'>; value: string; additive: boolean }
  | { type: 'facet/rangeSet'; ranges: readonly MegapixelRange[] }
  | { type: 'facet/cleared'; facet?: FacetId | undefined }
  | { type: 'facetComposition/set'; composition: FacetComposition }
  | { type: 'smartAlbum/set'; albumId: string; predicate: SmartPredicate }
  | { type: 'protectedAlbum/set'; albumId: string | null }
  | { type: 'selection/toggled'; photoId: string }
  | { type: 'selection/all'; photoIds: readonly string[] }
  | { type: 'selection/replaced'; photoIds: readonly string[] }
  | { type: 'selection/cleared' }
  | { type: 'lightbox/opened'; photoId: string }
  | { type: 'lightbox/stepped'; delta: 1 | -1 }
  | { type: 'lightbox/closed' }
  | { type: 'inspector/toggled' }
  | { type: 'sidebar/toggled' }
  | { type: 'inspector/detached' }
  | { type: 'inspector/detached-closed' }
  | { type: 'inspector/stepped'; delta: 1 | -1 }
  | { type: 'dialog/set'; dialog: 'import' | 'export' | 'settings' | 'libraries' | 'activity'; open: boolean }
  | { type: 'toast/shown'; toast: NonNullable<AppState['toast']> }
  | { type: 'toast/dismissed' }
  | { type: 'pendingCount/set'; count: number }
  | { type: 'backupLabel/set'; label: string }
  | { type: 'providerConnected/set'; connected: boolean }
  | { type: 'provider/set'; connected: boolean; label: string }
  | { type: 'escape' };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'photos/loaded': {
      if (action.append) {
        return { ...state, photos: [...state.photos, ...action.photos] };
      }
      // Explicit selections survive filter/source changes only for still-visible
      // items. A complete Select All selection spans unloaded pages and remains
      // intact while the same collection refetches (#884). The lightbox follows
      // visibility independently (#92): a photo that left the set closes it.
      const visible = new Set(action.photos.map((photo) => photo.id));
      const invalidateCompleteSelection = action.invalidateCompleteSelection === true && state.selectionMode === 'all';
      const selection = invalidateCompleteSelection
        ? new Set<string>()
        : state.selectionMode === 'all'
          ? new Set(state.selection)
          : new Set([...state.selection].filter((id) => visible.has(id)));
      const lightboxId = state.lightboxId !== null && visible.has(state.lightboxId) ? state.lightboxId : null;
      const inspectorClosedWithLightbox = state.inspectorSource === 'lightbox' && lightboxId === null && !state.inspectorDetached;
      const detachedFallbackToSelection = state.inspectorSource === 'lightbox' && lightboxId === null && state.inspectorDetached;
      const inspectorPhotoId = detachedFallbackToSelection
        ? selectedPhotoId(action.photos, selection, state.inspectorPhotoId)
        : state.inspectorSource === 'lightbox'
          ? lightboxId
          : selectedPhotoId(action.photos, selection, state.inspectorPhotoId);
      return {
        ...state,
        photos: action.photos,
        selection,
        selectionMode: invalidateCompleteSelection ? 'explicit' : state.selectionMode,
        selectionRevision: invalidateCompleteSelection ? state.selectionRevision + 1 : state.selectionRevision,
        lightboxId,
        inspectorOpen: inspectorClosedWithLightbox ? false : state.inspectorOpen,
        inspectorSource: inspectorClosedWithLightbox ? null : detachedFallbackToSelection ? 'selection' : state.inspectorSource,
        inspectorPhotoId: inspectorClosedWithLightbox ? null : inspectorPhotoId,
      };
    }
    case 'photos/records-patched': {
      const updates = new Map(action.photos.map((photo) => [photo.id, photo]));
      if (updates.size === 0) return state;
      return { ...state, photos: state.photos.map((photo) => updates.get(photo.id) ?? photo) };
    }
    case 'photos/sync-state-patched': {
      const updates = new Map(action.updates.map((update) => [update.id, update.syncState]));
      return {
        ...state,
        photos: state.photos.map((photo) => {
          const syncState = updates.get(photo.id);
          return syncState === undefined || syncState === photo.syncState ? photo : { ...photo, syncState };
        }),
      };
    }
    case 'thumbs/invalidated': {
      // Bump only the changed ids so exactly their tiles refetch; untouched
      // tiles keep their cached image. A no-op list leaves state identical.
      if (action.photoIds.length === 0) return state;
      const thumbEpoch = { ...state.thumbEpoch };
      for (const id of action.photoIds) thumbEpoch[id] = (thumbEpoch[id] ?? 0) + 1;
      return { ...state, thumbEpoch };
    }
    case 'query/set':
      return { ...state, query: action.query, selectionMode: 'explicit' };
    case 'searchMode/set':
      return { ...state, searchMode: action.mode, selectionMode: 'explicit' };
    case 'search/status':
      return { ...state, search: action.search };
    case 'zoom/set':
      return { ...state, zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, action.zoom)) };
    case 'view/set':
      return { ...state, view: action.view };
    case 'source/set':
      // Selection is NOT cleared here: the next photos/loaded intersects it
      // with the new visible set (still-visible items survive, #78).
      // Leaving a Smart Album drops its query; a live facet filter stays,
      // like the chips, until the user clears it (#514).
      return {
        ...state,
        source: action.source,
        album: null,
        protectedAlbum: null,
        smartAlbum: null,
        facets: state.smartAlbum === null ? state.facets : EMPTY_PREDICATE,
        selectionMode: 'explicit',
      };
    case 'chip/toggled': {
      const next = { ...state.chips, [action.chip]: state.chips[action.chip] !== true };
      return { ...state, chips: next, selectionMode: 'explicit' };
    }
    case 'album/set':
      // An album behaves like a source (design §Sidebar): selecting one
      // resets the source to 'all'; picking any source clears it below.
      return {
        ...state,
        album: action.albumId,
        protectedAlbum: null,
        source: 'all',
        smartAlbum: null,
        facets: state.smartAlbum === null ? state.facets : EMPTY_PREDICATE,
        selectionMode: 'explicit',
      };
    case 'facet/toggled':
      return { ...state, facets: toggleFacetValue(state.facets, action.facet, action.value, action.additive), selectionMode: 'explicit' };
    case 'facet/rangeSet':
      return { ...state, facets: setMegapixelRanges(state.facets, action.ranges), selectionMode: 'explicit' };
    case 'facet/cleared':
      return { ...state, facets: clearFacet(state.facets, action.facet), selectionMode: 'explicit' };
    case 'facetComposition/set':
      return { ...state, facets: setComposition(state.facets, action.composition), selectionMode: 'explicit' };
    case 'smartAlbum/set':
      // A Smart Album opens as its saved query over All Photos (ADR-0030 §3):
      // the facets become editable live, and saving writes them back.
      return {
        ...state,
        smartAlbum: action.albumId,
        facets: action.predicate,
        album: null,
        protectedAlbum: null,
        source: 'all',
        selectionMode: 'explicit',
      };
    case 'protectedAlbum/set':
      return {
        ...state,
        protectedAlbum: action.albumId,
        album: null,
        smartAlbum: null,
        facets: EMPTY_PREDICATE,
        source: 'all',
        photos: [],
        selection: new Set<string>(),
        selectionMode: 'explicit',
        selectionRevision: state.selectionRevision + 1,
        lightboxId: null,
        inspectorOpen: false,
        inspectorDetached: false,
        inspectorSource: null,
        inspectorPhotoId: null,
      };
    case 'sortOrder/set':
      // Fed by settings:changed pushes (#113) — the query hook refetches
      // without changing collection membership, so complete selection stays.
      return { ...state, sortOrder: action.order };
    case 'selection/toggled': {
      const selection = new Set(state.selection);
      if (selection.has(action.photoId)) {
        selection.delete(action.photoId);
      } else {
        selection.add(action.photoId);
      }
      return {
        ...state,
        selection,
        selectionMode: state.selectionMode === 'all' && selection.size > 0 ? 'all' : 'explicit',
        selectionRevision: state.selectionRevision + 1,
        inspectorPhotoId:
          state.inspectorSource === 'selection' ? selectedPhotoId(state.photos, selection, state.inspectorPhotoId) : state.inspectorPhotoId,
      };
    }
    case 'selection/all': {
      const selection = new Set(action.photoIds);
      return {
        ...state,
        selection,
        selectionMode: selection.size > 0 ? 'all' : 'explicit',
        selectionRevision: state.selectionRevision + 1,
        inspectorPhotoId:
          state.inspectorSource === 'selection' ? selectedPhotoId(state.photos, selection, state.inspectorPhotoId) : state.inspectorPhotoId,
      };
    }
    case 'selection/replaced': {
      const selection = new Set(action.photoIds);
      return {
        ...state,
        selection,
        selectionMode: 'explicit',
        selectionRevision: state.selectionRevision + 1,
        inspectorPhotoId:
          state.inspectorSource === 'selection' ? selectedPhotoId(state.photos, selection, state.inspectorPhotoId) : state.inspectorPhotoId,
      };
    }
    case 'selection/cleared':
      return {
        ...state,
        selection: new Set<string>(),
        selectionMode: 'explicit',
        selectionRevision: state.selectionRevision + 1,
        inspectorPhotoId: state.inspectorSource === 'selection' ? null : state.inspectorPhotoId,
      };
    case 'lightbox/opened':
      return {
        ...state,
        lightboxId: action.photoId,
        inspectorSource: state.inspectorOpen || state.inspectorDetached ? 'lightbox' : state.inspectorSource,
        inspectorPhotoId: state.inspectorOpen || state.inspectorDetached ? action.photoId : state.inspectorPhotoId,
      };
    case 'lightbox/stepped': {
      // ←/→ step the VISIBLE (filtered) sequence with wraparound (#93);
      // a closed lightbox or an empty page is a no-op.
      if (state.lightboxId === null || state.photos.length === 0) {
        return state;
      }
      const index = state.photos.findIndex((photo) => photo.id === state.lightboxId);
      if (index === -1) {
        return state;
      }
      const next = state.photos[(index + action.delta + state.photos.length) % state.photos.length];
      return next === undefined
        ? state
        : {
            ...state,
            lightboxId: next.id,
            inspectorPhotoId: state.inspectorSource === 'lightbox' ? next.id : state.inspectorPhotoId,
          };
    }
    case 'lightbox/closed':
      if (state.inspectorSource === 'lightbox' && state.inspectorDetached) {
        return {
          ...state,
          lightboxId: null,
          inspectorSource: 'selection',
          inspectorPhotoId: selectedPhotoId(state.photos, state.selection, null),
        };
      }
      return state.inspectorSource === 'lightbox'
        ? { ...state, lightboxId: null, inspectorOpen: false, inspectorSource: null, inspectorPhotoId: null }
        : { ...state, lightboxId: null };
    case 'sidebar/toggled':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case 'inspector/toggled': {
      if (state.inspectorOpen) {
        return { ...state, inspectorOpen: false, inspectorSource: null, inspectorPhotoId: null };
      }
      if (state.inspectorDetached) {
        return { ...state, inspectorOpen: true, inspectorDetached: false };
      }
      const inspectorSource = state.lightboxId === null ? 'selection' : 'lightbox';
      return {
        ...state,
        inspectorOpen: true,
        inspectorSource,
        inspectorPhotoId: inspectorSource === 'lightbox' ? state.lightboxId : selectedPhotoId(state.photos, state.selection, null),
      };
    }
    case 'inspector/detached': {
      const inspectorSource = state.lightboxId === null ? 'selection' : 'lightbox';
      return {
        ...state,
        inspectorOpen: false,
        inspectorDetached: true,
        inspectorSource,
        inspectorPhotoId:
          inspectorSource === 'lightbox' ? state.lightboxId : selectedPhotoId(state.photos, state.selection, state.inspectorPhotoId),
      };
    }
    case 'inspector/detached-closed':
      return state.inspectorDetached ? { ...state, inspectorDetached: false, inspectorSource: null, inspectorPhotoId: null } : state;
    case 'inspector/stepped': {
      if (state.inspectorSource !== 'selection') return state;
      const selected = state.photos.filter((photo) => state.selection.has(photo.id));
      if (selected.length === 0) return { ...state, inspectorPhotoId: null };
      const index = selected.findIndex((photo) => photo.id === state.inspectorPhotoId);
      const next = selected[(Math.max(index, 0) + action.delta + selected.length) % selected.length];
      return next === undefined ? state : { ...state, inspectorPhotoId: next.id };
    }
    case 'dialog/set':
      if (action.open) {
        return {
          ...state,
          importOpen: action.dialog === 'import',
          exportOpen: action.dialog === 'export',
          settingsOpen: action.dialog === 'settings',
          activityOpen: action.dialog === 'activity',
          librariesOpen: action.dialog === 'libraries',
        };
      }
      return {
        ...state,
        importOpen: action.dialog === 'import' ? action.open : state.importOpen,
        exportOpen: action.dialog === 'export' ? action.open : state.exportOpen,
        settingsOpen: action.dialog === 'settings' ? action.open : state.settingsOpen,
        activityOpen: action.dialog === 'activity' ? action.open : state.activityOpen,
        librariesOpen: action.dialog === 'libraries' ? action.open : state.librariesOpen,
      };
    case 'toast/shown':
      return { ...state, toast: action.toast };
    case 'toast/dismissed':
      return { ...state, toast: null };
    case 'pendingCount/set':
      return { ...state, pendingCount: action.count };
    case 'backupLabel/set':
      return { ...state, lastBackupLabel: action.label };
    case 'providerConnected/set':
      return { ...state, providerConnected: action.connected };
    case 'provider/set':
      return { ...state, providerConnected: action.connected, providerLabel: action.label };
    case 'escape':
      // Mock semantics: Esc exits the lightbox when open, otherwise clears
      // the selection.
      if (state.lightboxId !== null) {
        if (state.inspectorSource === 'lightbox' && state.inspectorDetached) {
          return {
            ...state,
            lightboxId: null,
            inspectorSource: 'selection',
            inspectorPhotoId: selectedPhotoId(state.photos, state.selection, null),
          };
        }
        return state.inspectorSource === 'lightbox'
          ? { ...state, lightboxId: null, inspectorOpen: false, inspectorSource: null, inspectorPhotoId: null }
          : { ...state, lightboxId: null };
      }
      return {
        ...state,
        selection: new Set<string>(),
        selectionMode: 'explicit',
        selectionRevision: state.selectionRevision + 1,
        inspectorPhotoId: state.inspectorSource === 'selection' ? null : state.inspectorPhotoId,
      };
  }
}

// #514 review: an open Smart Album is an explicit query even when its
// document has no groups (a cleared-then-saved album), so the page, the
// count, Select All and range selection all carry the predicate whenever one
// is open — never falling back to the inclusion-filtered All Photos view.
export function activePredicate(state: Pick<AppState, 'facets' | 'smartAlbum'>): SmartPredicate | undefined {
  return state.smartAlbum !== null || state.facets.groups.length > 0 ? state.facets : undefined;
}

function selectedPhotoId(photos: readonly PhotoRecord[], selection: ReadonlySet<string>, preferred: string | null): string | null {
  if (preferred !== null && selection.has(preferred) && photos.some((photo) => photo.id === preferred)) return preferred;
  return photos.find((photo) => selection.has(photo.id))?.id ?? null;
}
