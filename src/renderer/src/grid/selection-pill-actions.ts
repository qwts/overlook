/** The selection pill's actions (Pass E spec, #1304). Each sits inline until
 *  the pill runs out of room, then moves to ⋯ — never both. */
export type PillActionId = 'offload' | 'transfer' | 'export' | 'add' | 'original' | 'trash' | 'remove' | 'restore' | 'purge';

/** 1 leaves last. Trash and Remove share a slot (one or the other shows);
 *  so do Mark and Unmark, which collapse together. */
const PRIORITY: Readonly<Record<PillActionId, number>> = {
  export: 1,
  trash: 2,
  remove: 2,
  add: 3,
  offload: 4,
  original: 5,
  transfer: 6,
  restore: 1,
  purge: 2,
};

export const DANGER_ACTIONS: ReadonlySet<PillActionId> = new Set(['trash', 'purge']);

/** Level at which each action (given in inline order) collapses: the
 *  lowest-priority action goes at 1, the next at 2, and so on, so the pill's
 *  deepest level is the number of actions. */
export function collapseLevels(inline: readonly PillActionId[]): ReadonlyMap<PillActionId, number> {
  const byPriority = [...inline].sort((a, b) => PRIORITY[b] - PRIORITY[a]);
  return new Map(byPriority.map((id, index) => [id, index + 1]));
}

/** The actions ⋯ holds at `level`, in inline order; the rest stay inline. */
export function overflowFor(inline: readonly PillActionId[], level: number): readonly PillActionId[] {
  const levels = collapseLevels(inline);
  return inline.filter((id) => (levels.get(id) ?? 0) <= level);
}
