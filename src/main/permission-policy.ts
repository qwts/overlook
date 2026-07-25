import type { Session } from 'electron';

/** Deny renderer permission requests until a narrowly scoped use is approved. */
export function installDenyAllPermissionRequestHandler(defaultSession: Session): void {
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}
