import { events } from '../shared/ipc/channels.js';
import { createEmitter } from '../shared/ipc/registry.js';
import { broadcast } from './app-window.js';

const send = (name: string, payload: unknown): void => broadcast((win) => win.webContents.send(name, payload));
const emitLibraryChanged = createEmitter(events.libraryChanged, send);
const libraryChangedListeners = new Set<() => void>();

export const applicationEvents = {
  exportProgress: createEmitter(events.exportProgress, send),
  photoKitProgress: createEmitter(events.photoKitProgress, send),
  libraryChanged: (payload: Parameters<typeof emitLibraryChanged>[0]): void => {
    emitLibraryChanged(payload);
    for (const listener of libraryChangedListeners) {
      try {
        listener();
      } catch {
        // A local projection listener must not break the canonical renderer event.
      }
    }
  },
  onLibraryChanged: (listener: () => void): (() => void) => {
    libraryChangedListeners.add(listener);
    return () => libraryChangedListeners.delete(listener);
  },
  boardsReload: createEmitter(events.boardsReload, send),
};
