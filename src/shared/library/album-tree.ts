// Album folders (#505, ADR-0030 §1): the pure tree rules shared by the
// database layer, the backup manifest validator, and the sidebar. A folder
// holds other collections and never photos; `parentId` may only name a
// folder; positions order siblings; cycles are rejected; nesting depth is
// bounded so sidebar indentation and the recursive descendant queries stay
// inside a stated budget rather than degrading with an unbounded tree.

export type CollectionKind = 'album' | 'folder' | 'smart';

/** Root nodes sit at depth 0. Six levels keep one `--space-4` indent per
 * level inside the 216px rail with room for a name, and bound the recursive
 * queries the tree relies on. */
export const MAX_ALBUM_DEPTH = 6;

export interface AlbumTreeNode {
  readonly id: string;
  readonly kind: CollectionKind;
  readonly parentId: string | null;
  readonly position: number;
}

/** Structural problems with a proposed tree, in a stable order. Empty means
 * every parent resolves to a folder, there are no cycles, no node sits deeper
 * than `MAX_ALBUM_DEPTH`, and positions are unique among siblings. */
export function albumTreeIssues(nodes: readonly AlbumTreeNode[]): string[] {
  const issues: string[] = [];
  const byId = new Map<string, AlbumTreeNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) issues.push(`collection ${node.id} appears more than once`);
    byId.set(node.id, node);
  }
  const depthCache = new Map<string, number>();
  const depthOf = (node: AlbumTreeNode, trail: Set<string>): number | null => {
    const cached = depthCache.get(node.id);
    if (cached !== undefined) return cached;
    if (node.parentId === null) {
      depthCache.set(node.id, 0);
      return 0;
    }
    if (trail.has(node.id)) return null;
    trail.add(node.id);
    const parent = byId.get(node.parentId);
    if (parent === undefined || parent.kind !== 'folder') return null;
    const parentDepth = depthOf(parent, trail);
    if (parentDepth === null) return null;
    depthCache.set(node.id, parentDepth + 1);
    return parentDepth + 1;
  };
  const siblings = new Map<string | null, Set<number>>();
  for (const node of nodes) {
    if (node.parentId !== null) {
      const parent = byId.get(node.parentId);
      if (parent === undefined) issues.push(`collection ${node.id} names a parent that does not exist`);
      else if (parent.kind !== 'folder') issues.push(`collection ${node.id} names a parent that is not a folder`);
    }
    const depth = depthOf(node, new Set());
    if (depth === null && node.parentId !== null && byId.get(node.parentId)?.kind === 'folder') {
      issues.push(`collection ${node.id} is part of a cycle`);
    } else if (depth !== null && depth > MAX_ALBUM_DEPTH) {
      issues.push(`collection ${node.id} nests deeper than ${String(MAX_ALBUM_DEPTH)} levels`);
    }
    const taken = siblings.get(node.parentId) ?? new Set<number>();
    if (taken.has(node.position)) issues.push(`collection ${node.id} shares position ${String(node.position)} with a sibling`);
    taken.add(node.position);
    siblings.set(node.parentId, taken);
  }
  return issues;
}

/** Ids of every node under `rootId`, depth first, siblings by position. */
export function albumDescendantIds(nodes: readonly AlbumTreeNode[], rootId: string): string[] {
  const children = new Map<string | null, AlbumTreeNode[]>();
  for (const node of [...nodes].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string): void => {
    for (const child of children.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child.id);
      visit(child.id);
    }
  };
  visit(rootId);
  return out;
}
