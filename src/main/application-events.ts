import { events } from '../shared/ipc/channels.js';
import { createEmitter } from '../shared/ipc/registry.js';
import { broadcast } from './app-window.js';

const send = (name: string, payload: unknown): void => broadcast((win) => win.webContents.send(name, payload));

export const applicationEvents = {
  exportProgress: createEmitter(events.exportProgress, send),
  photoKitProgress: createEmitter(events.photoKitProgress, send),
  libraryChanged: createEmitter(events.libraryChanged, send),
  boardsReload: createEmitter(events.boardsReload, send),
};
