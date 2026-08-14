import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { PhotoRecord } from '../../../shared/library/types.js';
import type { Board } from '../../../shared/moodboard/board.js';
import type { PlacementAvailability } from '../../../shared/moodboard/availability.js';
import { Moodboard } from './Moodboard';
import { makeResolver, seedBoardFromPhotos } from './board-seed';

// Shell entry point for the Moodboard view (#515). Loads the persisted board
// from the encrypted library store (#694) and saves layout changes back
// (debounced), so the board survives restart and library switch — a switch does
// a full renderer reload, which re-runs this load against the newly activated
// library.db (invariant I2). The first time a library's board is opened it is
// seeded from the visible photos.
const BOARD_ID = 'board-local';
const LOCAL_BOARD_TITLE = 'Summer palette';
const SAVE_DEBOUNCE_MS = 400;

export interface MoodboardRouteProps {
  readonly photos: readonly PhotoRecord[];
  readonly onExport: (request: { readonly board: Board; readonly availability: Readonly<Record<string, PlacementAvailability>> }) => void;
}

function usable(photos: readonly PhotoRecord[]): readonly PhotoRecord[] {
  return photos.filter((photo) => photo.deletedAt === null);
}

export function MoodboardRoute({ photos, onExport }: MoodboardRouteProps): ReactElement | null {
  const [board, setBoard] = useState<Board | null>(null);
  const [checked, setChecked] = useState(false);
  // Bumped only when a pending empty seed is replaced once photos arrive, so
  // the canvas remounts with the real seed as its initial board (it owns board
  // state after mount, so a prop change alone would not take effect).
  const [generation, setGeneration] = useState(0);
  const resolvePlacement = useMemo(() => makeResolver(photos), [photos]);
  const availablePhotoIds = useMemo(() => usable(photos).map((photo) => photo.id), [photos]);
  // True while we hold an unsaved empty seed only because photos had not loaded
  // yet; cleared once real photos seed the board or the user edits it.
  const pendingSeedRef = useRef(false);
  const dirtyRef = useRef(false);
  const photosRef = useRef(photos);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const save = useCallback((next: Board) => {
    void window.overlook.boards.save({ board: next });
  }, []);

  // Load once from the store. If there is no saved board, seed from the photos
  // available now — but only persist a NON-empty seed, so opening the view
  // before the first photo page arrives never freezes an empty board (#694).
  useEffect(() => {
    let cancelled = false;
    void window.overlook.boards.get({ boardId: BOARD_ID }).then((result) => {
      if (cancelled) return;
      setChecked(true);
      if (result.board !== null) {
        setBoard(result.board);
        return;
      }
      const seeded = seedBoardFromPhotos(BOARD_ID, LOCAL_BOARD_TITLE, photosRef.current);
      setBoard(seeded);
      if (seeded.placements.length > 0) save(seeded);
      else pendingSeedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [save]);

  // Undo/redo rewrites the board in main; reload and remount the canvas so it
  // reflects the reverted layout instead of overwriting it (#695).
  useEffect(() => {
    return window.overlook.boards.onReload(({ boardId }) => {
      if (boardId !== BOARD_ID) return;
      // Cancel any pending debounced save: it captured the pre-undo board and
      // would otherwise write the reverted layout back after the reload.
      clearTimeout(saveTimer.current);
      void window.overlook.boards.get({ boardId: BOARD_ID }).then((result) => {
        if (result.board === null) return;
        dirtyRef.current = false;
        setBoard(result.board);
        setGeneration((current) => current + 1);
      });
    });
  }, []);

  // Re-seed once real photos arrive after an empty first render (and the user
  // has not touched the board), so the first saved board reflects the library.
  useEffect(() => {
    if (!pendingSeedRef.current || dirtyRef.current || usable(photos).length === 0) return;
    pendingSeedRef.current = false;
    const seeded = seedBoardFromPhotos(BOARD_ID, LOCAL_BOARD_TITLE, photos);
    setBoard(seeded);
    setGeneration((current) => current + 1);
    save(seeded);
  }, [photos, save]);

  // Persist edits, debounced. No unmount flush: a library switch is a hard
  // renderer reload that discards this timer, so a deferred save can never land
  // in the wrong library's store (#694 review).
  const onBoardChange = useCallback(
    (next: Board) => {
      dirtyRef.current = true;
      pendingSeedRef.current = false;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(next), SAVE_DEBOUNCE_MS);
    },
    [save],
  );

  if (!checked || board === null) return null;

  return (
    <Moodboard
      key={generation}
      board={board}
      resolvePlacement={resolvePlacement}
      availablePhotoIds={availablePhotoIds}
      onExport={onExport}
      onBoardChange={onBoardChange}
    />
  );
}
