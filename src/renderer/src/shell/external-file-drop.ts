import { ALBUM_REORDER_DRAG_TYPE } from '../../../shared/library/album-reorder-drag.js';
import { PHOTO_DRAG_TYPE } from '../../../shared/library/photo-drag.js';

const PASSTHROUGH_SELECTOR = '[data-overlook-file-drop-target]';
const MAX_DIAGNOSTICS = 16;
const MAX_EVENT_PATH = 6;
const MAX_KINDS = 8;

type DropPhase = 'enter' | 'drop' | 'reset';

export interface ExternalDropDiagnostic {
  readonly phase: DropPhase;
  readonly reason?: string;
  readonly eventPath: readonly string[];
  readonly transferTypes: readonly string[];
  readonly fileKinds: readonly string[];
  readonly fileCount: number;
}

export interface ExternalFileDropOptions {
  readonly pathForFile: (file: File) => string;
  readonly onDraggingChange: (dragging: boolean) => void;
  readonly onPaths: (paths: readonly string[]) => void;
  readonly onUnsupported: () => void;
  readonly report?: ((diagnostic: ExternalDropDiagnostic) => void) | undefined;
}

export interface ExternalFileDropBoundary {
  readonly reset: (reason: string) => void;
  readonly dispose: () => void;
}

function transferTypes(transfer: DataTransfer | null): readonly string[] {
  return transfer === null
    ? []
    : Array.from(transfer.types)
        .slice(0, MAX_KINDS)
        .map((type) => type.slice(0, 64));
}

function isInternalLibraryDrag(transfer: DataTransfer | null): boolean {
  const types = transferTypes(transfer);
  return types.includes(PHOTO_DRAG_TYPE) || types.includes(ALBUM_REORDER_DRAG_TYPE);
}

function isFileTransfer(transfer: DataTransfer | null): boolean {
  if (transfer === null) return false;
  if (transfer.files.length > 0) return true;
  if (Array.from(transfer.items).some((item) => item.kind === 'file')) return true;
  return transferTypes(transfer).some((type) => type.toLocaleLowerCase('en-US').includes('file'));
}

function filesFrom(transfer: DataTransfer | null): readonly File[] {
  if (transfer === null) return [];
  const files = Array.from(transfer.files);
  if (files.length > 0) return files;
  return Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

function fileKind(file: File): string {
  const extension = /\.([a-z0-9]{1,12})$/iu.exec(file.name)?.[1];
  if (extension !== undefined) return extension.toLocaleLowerCase('en-US');
  const mimeFamily = file.type.split('/')[0];
  return mimeFamily === undefined || mimeFamily === '' ? 'unknown' : mimeFamily.slice(0, 24);
}

function eventPath(event: DragEvent): readonly string[] {
  return event
    .composedPath()
    .filter((entry): entry is Element => entry instanceof Element)
    .slice(0, MAX_EVENT_PATH)
    .map((element) => {
      const role = element.getAttribute('role');
      return role === null ? element.tagName.toLocaleLowerCase('en-US') : `${element.tagName.toLocaleLowerCase('en-US')}[role=${role}]`;
    });
}

function diagnostic(phase: DropPhase, event?: DragEvent, reason?: string): ExternalDropDiagnostic {
  const transfer = event?.dataTransfer ?? null;
  const files = filesFrom(transfer);
  return {
    phase,
    ...(reason === undefined ? {} : { reason }),
    eventPath: event === undefined ? [] : eventPath(event),
    transferTypes: transferTypes(transfer),
    fileKinds: files.slice(0, MAX_KINDS).map(fileKind),
    fileCount: files.length,
  };
}

export function createBoundedExternalDropReporter(
  write: (diagnostic: ExternalDropDiagnostic) => void = (entry) => console.info('[overlook] external file drop', entry),
): (diagnostic: ExternalDropDiagnostic) => void {
  let count = 0;
  return (entry) => {
    if (count >= MAX_DIAGNOSTICS) return;
    count += 1;
    write(entry);
  };
}

function isPassthroughTarget(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(PASSTHROUGH_SELECTOR) !== null;
}

/** Own external file drags at the window capture boundary so portals, modal
 * scrims, and shell descendants cannot leak Chromium's default file action. */
export function installExternalFileDropBoundary(
  host: Window,
  { pathForFile, onDraggingChange, onPaths, onUnsupported, report = createBoundedExternalDropReporter() }: ExternalFileDropOptions,
): ExternalFileDropBoundary {
  let dragging = false;
  let leaveTimer: number | undefined;

  const cancelLeave = (): void => {
    if (leaveTimer === undefined) return;
    host.clearTimeout(leaveTimer);
    leaveTimer = undefined;
  };
  const setDragging = (next: boolean): void => {
    if (dragging === next) return;
    dragging = next;
    onDraggingChange(next);
  };
  const reset = (reason: string): void => {
    cancelLeave();
    if (!dragging) return;
    setDragging(false);
    report(diagnostic('reset', undefined, reason));
  };
  const shouldPassThrough = (event: DragEvent): boolean => isPassthroughTarget(event) || isInternalLibraryDrag(event.dataTransfer);

  const onDragEnter = (event: DragEvent): void => {
    if (shouldPassThrough(event)) {
      reset('app-drop-target');
      return;
    }
    event.preventDefault();
    cancelLeave();
    if (!isFileTransfer(event.dataTransfer)) return;
    const wasDragging = dragging;
    setDragging(true);
    if (!wasDragging) report(diagnostic('enter', event));
  };
  const onDragOver = (event: DragEvent): void => {
    if (shouldPassThrough(event)) return;
    event.preventDefault();
    cancelLeave();
    const transfer = event.dataTransfer;
    if (!isFileTransfer(transfer) || transfer === null) return;
    transfer.dropEffect = 'copy';
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent): void => {
    if (!dragging || shouldPassThrough(event)) return;
    event.preventDefault();
    cancelLeave();
    leaveTimer = host.setTimeout(() => reset('pointer-left-window'), 0);
  };
  const onDrop = (event: DragEvent): void => {
    if (shouldPassThrough(event)) {
      reset('app-drop-target');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const fileTransfer = isFileTransfer(event.dataTransfer);
    const files = filesFrom(event.dataTransfer);
    reset('drop');
    if (!fileTransfer) return;
    report(diagnostic('drop', event));
    const paths = [...new Set(files.map(pathForFile).filter((path) => path !== ''))];
    if (paths.length === 0) {
      onUnsupported();
      return;
    }
    onPaths(paths);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') reset('escape');
  };
  const onBlur = (): void => reset('window-blur');
  const onVisibilityChange = (): void => {
    if (host.document.visibilityState !== 'visible') reset('document-hidden');
  };

  host.addEventListener('dragenter', onDragEnter, true);
  host.addEventListener('dragover', onDragOver, true);
  host.addEventListener('dragleave', onDragLeave, true);
  host.addEventListener('drop', onDrop, true);
  host.addEventListener('blur', onBlur);
  host.addEventListener('keydown', onKeyDown, true);
  host.document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    reset,
    dispose: () => {
      cancelLeave();
      host.removeEventListener('dragenter', onDragEnter, true);
      host.removeEventListener('dragover', onDragOver, true);
      host.removeEventListener('dragleave', onDragLeave, true);
      host.removeEventListener('drop', onDrop, true);
      host.removeEventListener('blur', onBlur);
      host.removeEventListener('keydown', onKeyDown, true);
      host.document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
