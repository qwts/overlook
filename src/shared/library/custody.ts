/** Why the active library cannot be opened. `ok` includes a missing master
 * (first run) and an app-lock record, which the lock screen owns. */
export const libraryCustodyStates = ['ok', 'unwrap-failed', 'malformed', 'keychain-unavailable'] as const;

export type LibraryCustodyState = (typeof libraryCustodyStates)[number];
