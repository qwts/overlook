import { useState, type ReactElement } from 'react';

import type { Board } from '../../../shared/moodboard/board.js';
import type { PlacementAvailability } from '../../../shared/moodboard/availability.js';
import { useAppDispatch, useAppState } from '../state/app-state-context';
import { BoardExportDialog } from './BoardExportDialog';
import { ExportDialog } from './ExportDialog';

export interface BoardExportSelection {
  readonly board: Board;
  readonly availability: Readonly<Record<string, PlacementAvailability>>;
}

export interface ExportDialogController {
  readonly dialog: ReactElement | null;
  readonly openPhotos: (photoIds: readonly string[]) => void;
  readonly openBoard: (request: BoardExportSelection) => void;
  readonly setPhotoIds: (photoIds: readonly string[] | null) => void;
  readonly setAllPhotos: (allPhotos: boolean) => void;
}

export function useExportDialog(): ExportDialogController {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<readonly string[] | null>(null);
  const [allPhotos, setAllPhotos] = useState(false);
  const [boardSelection, setBoardSelection] = useState<BoardExportSelection | null>(null);
  const close = (): void => {
    setAllPhotos(false);
    setSelectedPhotoIds(null);
    setBoardSelection(null);
    dispatch({ type: 'dialog/set', dialog: 'export', open: false });
  };
  const setPhotoIds = (next: readonly string[] | null): void => {
    setBoardSelection(null);
    setSelectedPhotoIds(next);
  };
  const openPhotos = (next: readonly string[]): void => {
    setPhotoIds([...next]);
    setAllPhotos(false);
    dispatch({ type: 'dialog/set', dialog: 'export', open: true });
  };
  const openBoard = (request: BoardExportSelection): void => {
    setSelectedPhotoIds(null);
    setAllPhotos(false);
    setBoardSelection(request);
    dispatch({ type: 'dialog/set', dialog: 'export', open: true });
  };

  const dialog = !state.exportOpen ? null : boardSelection !== null ? (
    <BoardExportDialog board={boardSelection.board} availability={boardSelection.availability} onClose={close} />
  ) : (
    <ExportDialog
      open
      photoIds={selectedPhotoIds ?? (state.lightboxId !== null ? [state.lightboxId] : [...state.selection])}
      allPhotos={allPhotos}
      onClose={close}
    />
  );
  return { dialog, openPhotos, openBoard, setPhotoIds, setAllPhotos };
}
