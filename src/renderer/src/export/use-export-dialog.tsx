import { useState, useRef, useLayoutEffect, type ReactElement } from 'react';
import { useIntl } from 'react-intl';
import { currentDialogScope } from '../components/use-dialog-keyboard.js';
import { photoCommandTargets } from '../commands/photo-command-targets.js';

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
  readonly openPhotos: (photoIds: readonly string[], target?: 'snapshot' | 'live') => void;
  readonly openBoard: (request: BoardExportSelection) => void;
  readonly setPhotoIds: (photoIds: readonly string[] | null) => void;
  readonly setAllPhotos: (allPhotos: boolean) => void;
}

export function useExportDialog(): ExportDialogController {
  const state = useAppState();
  const intl = useIntl();
  const requestRef = useRef(0);
  const targetKey = JSON.stringify(state.lightboxId === null ? [...state.selection] : [state.lightboxId]);
  const liveTargetRevisionRef = useRef(0);
  useLayoutEffect(() => {
    liveTargetRevisionRef.current++;
  }, [targetKey]);
  useLayoutEffect(
    () => () => {
      requestRef.current++;
    },
    [state.protectedAlbum, state.dialogRevision],
  );
  const dispatch = useAppDispatch();
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<readonly string[] | null>(null);
  const [allPhotos, setAllPhotos] = useState(false);
  const [boardSelection, setBoardSelection] = useState<BoardExportSelection | null>(null);
  const close = (): void => {
    requestRef.current++;
    setAllPhotos(false);
    setSelectedPhotoIds(null);
    setBoardSelection(null);
    dispatch({ type: 'dialog/set', dialog: 'export', open: false });
  };
  const setPhotoIds = (next: readonly string[] | null): void => {
    requestRef.current++;
    setBoardSelection(null);
    setSelectedPhotoIds(next);
  };
  const openPhotos = (next: readonly string[], target: 'snapshot' | 'live' = 'snapshot'): void => {
    const dialogScope = currentDialogScope();
    if (dialogScope.open) return;
    const invocation = ++requestRef.current;
    const targetRevision = liveTargetRevisionRef.current;
    void photoCommandTargets('photo.export', next, intl).then(({ photoIds: eligible, notice }) => {
      // Context menus restore the prior selection after invoking their captured
      // targets. Only selection-bound commands follow later selection changes.
      if (
        requestRef.current !== invocation ||
        currentDialogScope().revision !== dialogScope.revision ||
        (target === 'live' && liveTargetRevisionRef.current !== targetRevision)
      )
        return;
      if (notice !== null) dispatch({ type: 'toast/shown', toast: { title: notice, tone: 'amber' } });
      if (eligible.length === 0) return;
      setPhotoIds(eligible);
      setAllPhotos(false);
      dispatch({ type: 'dialog/set', dialog: 'export', open: true });
    });
  };
  const openBoard = (selection: BoardExportSelection): void => {
    requestRef.current++;
    setSelectedPhotoIds(null);
    setAllPhotos(false);
    setBoardSelection(selection);
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
