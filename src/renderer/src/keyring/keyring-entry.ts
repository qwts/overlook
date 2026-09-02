import type { OverlookApi } from '../../../shared/ipc/api.js';

/** One registry row as the keyring IPC (#517) hands it to the renderer. */
export type KeyringEntry = Awaited<ReturnType<OverlookApi['keyring']['list']>>['keys'][number];
