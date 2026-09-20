import { canonicalJson, type EditOperation } from './edit-revision.js';

/** The fields needed to walk immutable history, independent of storage or IPC. */
interface RevertRevision {
  readonly id: string;
  readonly parentId: string | null;
  readonly operations: readonly EditOperation[];
  readonly unsupported: string | null;
}

/** Repeated Revert follows the earliest matching stack in the current lineage,
 * stopping at an empty or unsupported stack. Copying a stack appends history,
 * but does not put the state we just left back on the next Revert path.
 * A manually saved duplicate stack has the same semantics as a restored one.
 * No timestamps or session-local cursor are needed; reopening is deterministic.
 * Null means no safe earlier state; revisionId null names the implicit root. */
export function previousEditState(
  head: RevertRevision | null,
  history: readonly RevertRevision[],
): { readonly revisionId: string | null; readonly operations: readonly EditOperation[] } | null {
  if (head === null || head.unsupported !== null || head.operations.length === 0) return null;
  const byId = new Map(history.map((revision) => [revision.id, revision]));
  const stack = canonicalJson(head.operations);
  const visited = new Set([head.id]);
  let anchor = head;
  let cursor = head;
  while (cursor.parentId !== null) {
    const parent = byId.get(cursor.parentId);
    if (parent === undefined || visited.has(parent.id)) return null;
    visited.add(parent.id);
    if (parent.unsupported !== null || parent.operations.length === 0) break;
    if (canonicalJson(parent.operations) === stack) anchor = parent;
    cursor = parent;
  }
  if (anchor.parentId === null) return { revisionId: null, operations: [] };
  const target = byId.get(anchor.parentId);
  return target === undefined || target.unsupported !== null ? null : { revisionId: target.id, operations: target.operations };
}
