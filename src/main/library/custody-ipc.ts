import { ipcMain } from 'electron';

import type { LibraryCustodyState } from '../../shared/library/custody.js';
import { channels } from '../../shared/ipc/channels.js';
import { wrapHandler } from '../../shared/ipc/registry.js';

/** Custody is readable without opening the database. Handlers that need the
 * library keep going through `getLibraryService`. */
export function registerCustodyHandlers(read: () => LibraryCustodyState): void {
  ipcMain.handle(channels.libraryCustody.name, (_event, request: unknown) =>
    wrapHandler(channels.libraryCustody, () => ({ state: read() }))(request),
  );
}
