import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { CommandId } from '../../../shared/commands/registry.js';
import type { AlbumSummary } from '../../../shared/library/types.js';
import { MAX_ALBUM_DEPTH, type CollectionKind } from '../../../shared/library/album-tree.js';
import { albumDropPlacement } from '../../../shared/library/album-drop-placement.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { beginAlbumReorderDrag, endAlbumReorderDrag, hasAlbumReorderDrag, readAlbumReorderDrag } from './album-reorder-drag-session';

export type AlbumReorderCommand = Extract<CommandId, `album.reorder.${string}`>;

/** Rows carry folder placement for sibling reorders and cross-folder drops.
 * A flat list (no `parentId`) remains one sibling group. */
export interface ReorderableAlbum extends AlbumSummary {
  readonly parentId?: string | null | undefined;
  readonly kind?: CollectionKind | undefined;
}

const messages = defineMessages({
  grabbed: {
    id: 'album.reorder.grabbed',
    defaultMessage: 'Grabbed {name}. Use Up and Down arrows to move, Space to drop, Escape to cancel.',
  },
  position: { id: 'album.reorder.position', defaultMessage: '{name}, position {position} of {total}.' },
  alreadyFirst: { id: 'album.reorder.alreadyFirst', defaultMessage: '{name} is already first.' },
  alreadyLast: { id: 'album.reorder.alreadyLast', defaultMessage: '{name} is already last.' },
  moved: { id: 'album.reorder.moved', defaultMessage: '{name} moved to position {position} of {total}.' },
  stayed: { id: 'album.reorder.stayed', defaultMessage: '{name} stays at position {position} of {total}.' },
  cancelled: { id: 'album.reorder.cancelled', defaultMessage: 'Move cancelled. {name} returned to position {position} of {total}.' },
  changed: { id: 'album.reorder.listChanged', defaultMessage: 'Album list changed — move cancelled.' },
  failed: { id: 'album.reorder.failed', defaultMessage: 'Could not reorder {name}.' },
  movedTo: { id: 'album.drag.movedTo', defaultMessage: 'Moved {name} to {destination}.' },
  cycleRefused: { id: 'album.drag.cycleRefused', defaultMessage: 'a folder cannot be moved into itself' },
  depthRefused: { id: 'album.drag.depthRefused', defaultMessage: 'albums nest at most {maxDepth} levels deep' },
  unexpectedFailure: { id: 'album.drag.unexpectedFailure', defaultMessage: 'please try again' },
  moveFailed: { id: 'album.drag.failed', defaultMessage: 'Could not move {name}: {reason}.' },
  destination: { id: 'album.drag.destination', defaultMessage: 'Move {name} to {destination}, position {position}.' },
  topLevel: { id: 'album.drag.topLevel', defaultMessage: 'top-level Albums' },
  handle: { id: 'album.reorder.handle', defaultMessage: 'Reorder {name}, position {position} of {total}' },
  movingHandle: {
    id: 'album.reorder.handleMoving',
    defaultMessage: 'Moving {name}, position {position} of {total}. Arrow keys move, Space drops, Escape cancels.',
  },
});

const ids = (albums: readonly ReorderableAlbum[]): string[] => albums.map(({ id }) => id);
const sameOrder = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);
const parentOf = (album: ReorderableAlbum | undefined): string | null => album?.parentId ?? null;

/** The ids sharing `albumId`'s parent, in `order`. */
function siblingsOf(albums: ReadonlyMap<string, ReorderableAlbum>, order: readonly string[], albumId: string): string[] {
  const parentId = parentOf(albums.get(albumId));
  return order.filter((id) => parentOf(albums.get(id)) === parentId);
}

/** Moves `albumId` to `position` among its siblings and re-derives the
 * depth-first order of the whole list, so a folder carries its children. */
function move(albums: ReadonlyMap<string, ReorderableAlbum>, order: readonly string[], albumId: string, position: number): string[] {
  const siblings = siblingsOf(albums, order, albumId);
  if (!siblings.includes(albumId)) return [...order];
  const next = siblings.filter((id) => id !== albumId);
  next.splice(Math.max(0, Math.min(position, next.length)), 0, albumId);
  const children = new Map<string | null, string[]>();
  for (const id of order) {
    const parentId = parentOf(albums.get(id));
    children.set(parentId, [...(children.get(parentId) ?? []), id]);
  }
  children.set(parentOf(albums.get(albumId)), next);
  const out: string[] = [];
  const visit = (parentId: string | null): void => {
    for (const id of children.get(parentId) ?? []) {
      out.push(id);
      visit(id);
    }
  };
  visit(null);
  return out.length === order.length ? out : [...order];
}

function commandFor(from: number, to: number, total: number): AlbumReorderCommand {
  if (to === 0) return 'album.reorder.top';
  if (to === total - 1) return 'album.reorder.bottom';
  return to < from ? 'album.reorder.up' : 'album.reorder.down';
}

export function useAlbumReorder<T extends ReorderableAlbum>(
  albums: readonly T[],
  onMoved?: (parentId: string | null) => void,
): {
  readonly albums: readonly T[];
  readonly grabbedId: string | null;
  readonly draggingId: string | null;
  readonly invalid: boolean;
  readonly dropTarget: { readonly albumId: string; readonly label: string } | null;
  readonly instructionId: string;
  /** Sibling index and sibling count of a row in the displayed order. */
  readonly placement: (albumId: string) => { readonly position: number; readonly total: number };
  readonly moveByCommand: (album: ReorderableAlbum, command: AlbumReorderCommand) => void;
  readonly handleProps: (album: ReorderableAlbum) => {
    readonly ref: (node: HTMLButtonElement | null) => void;
    readonly draggable: true;
    readonly disabled: boolean;
    readonly 'aria-label': string;
    readonly 'aria-describedby': string;
    readonly 'aria-grabbed': boolean | undefined;
    readonly onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
    readonly onDragEnd: () => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  };
  readonly rowProps: (album: ReorderableAlbum) => {
    readonly onDragEnter: (event: DragEvent<HTMLLIElement>) => void;
    readonly onDragOver: (event: DragEvent<HTMLLIElement>) => void;
    readonly onDragLeave: (event: DragEvent<HTMLLIElement>) => void;
    readonly onDrop: (event: DragEvent<HTMLLIElement>) => void;
  };
  readonly invalidZoneProps: {
    readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
    readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  };
} {
  const intl = useIntl();
  const { announce } = useAnnouncer();
  const incomingOrder = useMemo(() => ids(albums), [albums]);
  const [previewOrder, setPreviewOrder] = useState<readonly string[] | null>(null);
  const [grabbedId, setGrabbedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ albumId: string; label: string } | null>(null);
  const dropRef = useRef<{ sourceId: string; targetId: string; parentId: string | null; position: number } | null>(null);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const [focusRequest, setFocusRequest] = useState<{ id: string; parentId: string | null } | null>(null);
  const originRef = useRef<readonly string[]>(incomingOrder);
  const interactionSignatureRef = useRef('');
  const pointerCommittedRef = useRef(false);
  const displayOrder = previewOrder ?? incomingOrder;
  const byId = useMemo(() => new Map<string, T>(albums.map((album) => [album.id, album])), [albums]);
  useEffect(() => {
    if (focusRequest === null || parentOf(byId.get(focusRequest.id)) !== focusRequest.parentId) return;
    const handle = handles.current.get(focusRequest.id);
    if (handle?.isConnected !== true) return;
    const frame = requestAnimationFrame(() => {
      handle.focus();
      setFocusRequest(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [byId, focusRequest]);
  const orderedAlbums = displayOrder.flatMap((id) => {
    const album = byId.get(id);
    return album === undefined ? [] : [album];
  });
  const publish = useCallback((message: string): void => announce(message, 'polite', 'album-reorder'), [announce]);
  const placementIn = (order: readonly string[], albumId: string): { position: number; total: number } => {
    const siblings = siblingsOf(byId, order, albumId);
    return { position: siblings.indexOf(albumId), total: siblings.length };
  };

  const signature = albums.map(({ id, name, parentId }) => `${id}\u0000${name}\u0000${parentId ?? ''}`).join('\u0001');
  useEffect(() => {
    const changedDuringInteraction = (grabbedId !== null || draggingId !== null) && interactionSignatureRef.current !== signature;
    const persistedPreview = grabbedId === null && draggingId === null && previewOrder !== null && sameOrder(previewOrder, incomingOrder);
    if (!changedDuringInteraction && !persistedPreview) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (changedDuringInteraction) {
        setGrabbedId(null);
        setDraggingId(null);
        setDropTarget(null);
        dropRef.current = null;
        endAlbumReorderDrag();
        publish(intl.formatMessage(messages.changed));
      }
      setPreviewOrder(null);
    });
    return () => {
      active = false;
    };
  }, [draggingId, grabbedId, incomingOrder, intl, previewOrder, publish, signature]);

  const announcePosition = (album: ReorderableAlbum, order: readonly string[]): void => {
    const { position, total } = placementIn(order, album.id);
    publish(intl.formatMessage(messages.position, { name: album.name, position: position + 1, total }));
  };

  const commit = (album: ReorderableAlbum, next: readonly string[], commandId: AlbumReorderCommand): void => {
    const { position, total } = placementIn(next, album.id);
    const unchanged = sameOrder(originRef.current, next);
    setGrabbedId(null);
    setDraggingId(null);
    setInvalid(false);
    setDropTarget(null);
    dropRef.current = null;
    endAlbumReorderDrag();
    if (unchanged) {
      setPreviewOrder(null);
      publish(intl.formatMessage(messages.stayed, { name: album.name, position: position + 1, total }));
      return;
    }
    setPreviewOrder(next);
    void window.overlook.albums
      .reorder({ albumId: album.id, position, commandId })
      .then((result) => {
        publish(
          intl.formatMessage(result.changed ? messages.moved : messages.stayed, {
            name: album.name,
            position: result.position + 1,
            total: result.total,
          }),
        );
      })
      .catch(() => {
        setPreviewOrder(null);
        publish(intl.formatMessage(messages.failed, { name: album.name }));
      });
  };

  const cancel = (album: ReorderableAlbum): void => {
    const { position, total } = placementIn(originRef.current, album.id);
    setPreviewOrder(null);
    setDropTarget(null);
    dropRef.current = null;
    handles.current.get(album.id)?.focus();
    publish(intl.formatMessage(messages.cancelled, { name: album.name, position: position + 1, total }));
  };

  const begin = (album: ReorderableAlbum): void => {
    setFocusRequest(null);
    originRef.current = displayOrder;
    interactionSignatureRef.current = signature;
    setGrabbedId(album.id);
    publish(intl.formatMessage(messages.grabbed, { name: album.name }));
  };

  const targetFor = (key: string, current: number, total: number): number =>
    key === 'Home' || key === 'album.reorder.top'
      ? 0
      : key === 'End' || key === 'album.reorder.bottom'
        ? total - 1
        : key === 'ArrowUp' || key === 'album.reorder.up'
          ? Math.max(0, current - 1)
          : Math.min(total - 1, current + 1);

  const moveByCommand = (album: ReorderableAlbum, command: AlbumReorderCommand): void => {
    const order = incomingOrder;
    const { position, total } = placementIn(order, album.id);
    originRef.current = order;
    commit(album, move(byId, order, album.id, targetFor(command, position, total)), command);
  };

  return {
    albums: orderedAlbums,
    grabbedId,
    draggingId,
    invalid,
    dropTarget,
    instructionId: 'album-reorder-instructions',
    placement: (albumId) => placementIn(displayOrder, albumId),
    moveByCommand,
    handleProps: (album) => {
      const { position, total } = placementIn(displayOrder, album.id);
      const grabbed = grabbedId === album.id;
      return {
        ref: (node) => {
          if (node === null) handles.current.delete(album.id);
          else handles.current.set(album.id, node);
        },
        draggable: true,
        disabled: false,
        'aria-label': intl.formatMessage(grabbed ? messages.movingHandle : messages.handle, {
          name: album.name,
          position: position + 1,
          total,
        }),
        'aria-describedby': 'album-reorder-instructions',
        'aria-grabbed': grabbed ? true : undefined,
        onDragStart: (event) => {
          setFocusRequest(null);
          event.currentTarget.focus();
          originRef.current = displayOrder;
          interactionSignatureRef.current = signature;
          pointerCommittedRef.current = false;
          setDraggingId(album.id);
          beginAlbumReorderDrag(event.dataTransfer, album.id);
        },
        onDragEnd: () => {
          if (pointerCommittedRef.current) {
            pointerCommittedRef.current = false;
            return;
          }
          if (draggingId === album.id) {
            setDraggingId(null);
            setInvalid(false);
            endAlbumReorderDrag();
            cancel(album);
          }
        },
        onKeyDown: (event) => {
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            event.stopPropagation();
            moveByCommand(album, event.key === 'ArrowUp' ? 'album.reorder.up' : 'album.reorder.down');
            return;
          }
          if ((event.key === ' ' || event.key === 'Enter') && grabbedId !== album.id) {
            event.preventDefault();
            event.stopPropagation();
            begin(album);
            return;
          }
          if (grabbedId !== album.id) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setGrabbedId(null);
            cancel(album);
            return;
          }
          if (event.key === ' ' || event.key === 'Enter' || event.key === 'Tab') {
            if (event.key !== 'Tab') {
              event.preventDefault();
              event.stopPropagation();
            }
            const from = placementIn(originRef.current, album.id).position;
            const { position: to, total: count } = placementIn(displayOrder, album.id);
            commit(album, displayOrder, commandFor(from, to, count));
            return;
          }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const { position: current, total: count } = placementIn(displayOrder, album.id);
          const target = targetFor(event.key, current, count);
          if (target === current) {
            publish(intl.formatMessage(target === 0 ? messages.alreadyFirst : messages.alreadyLast, { name: album.name }));
            return;
          }
          const next = move(byId, displayOrder, album.id, target);
          setPreviewOrder(next);
          announcePosition(album, next);
        },
      };
    },
    rowProps: (target) => {
      const accept = (event: DragEvent<HTMLLIElement>) => {
        if (!hasAlbumReorderDrag(event.dataTransfer)) return null;
        const payload = readAlbumReorderDrag(event.dataTransfer);
        if (payload === null) return null;
        const bounds = event.currentTarget.getBoundingClientRect();
        const fraction = (event.clientY - bounds.top) / Math.max(1, bounds.height);
        const zone = target.kind === 'folder' && fraction >= 0.25 && fraction <= 0.75 ? 'inside' : fraction < 0.5 ? 'before' : 'after';
        const placement = albumDropPlacement(orderedAlbums, payload.albumId, target.id, zone);
        if (placement === null) return null;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setInvalid(false);
        return { sourceId: payload.albumId, targetId: target.id, ...placement };
      };
      const preview = (event: DragEvent<HTMLLIElement>): void => {
        const drop = accept(event);
        if (drop === null) return;
        dropRef.current = drop;
        const album = byId.get(drop.sourceId);
        if (parentOf(album) === drop.parentId) {
          setDropTarget(null);
          setPreviewOrder(move(byId, displayOrder, drop.sourceId, drop.position));
        } else {
          setPreviewOrder(null);
          setDropTarget({
            albumId: target.id,
            label: intl.formatMessage(messages.destination, {
              name: album?.name ?? '',
              destination: drop.parentId === null ? intl.formatMessage(messages.topLevel) : (byId.get(drop.parentId)?.name ?? ''),
              position: drop.position + 1,
            }),
          });
        }
      };
      return {
        onDragEnter: preview,
        onDragOver: preview,
        onDragLeave: (event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          if (dropRef.current?.targetId === target.id) {
            dropRef.current = null;
            setDropTarget(null);
          }
        },
        onDrop: (event) => {
          const accepted = accept(event);
          const drop =
            accepted !== null && dropRef.current?.targetId === target.id && dropRef.current.sourceId === accepted.sourceId
              ? dropRef.current
              : accepted;
          const album = drop === null ? undefined : byId.get(drop.sourceId);
          if (album === undefined || drop === null) return;
          pointerCommittedRef.current = true;
          if (parentOf(album) !== drop.parentId) {
            setGrabbedId(null);
            setDraggingId(null);
            setPreviewOrder(null);
            setDropTarget(null);
            dropRef.current = null;
            endAlbumReorderDrag();
            const destination = drop.parentId === null ? intl.formatMessage(messages.topLevel) : (byId.get(drop.parentId)?.name ?? '');
            void window.overlook.albums
              .move({ albumId: album.id, parentId: drop.parentId, position: drop.position })
              .then((result) => {
                if ('refusal' in result) {
                  handles.current.get(album.id)?.focus();
                  publish(
                    intl.formatMessage(messages.moveFailed, {
                      name: album.name,
                      reason:
                        result.refusal === 'cycle'
                          ? intl.formatMessage(messages.cycleRefused)
                          : intl.formatMessage(messages.depthRefused, { maxDepth: MAX_ALBUM_DEPTH }),
                    }),
                  );
                  return;
                }
                const moved = result.album;
                onMoved?.(moved.parentId);
                setFocusRequest({ id: moved.id, parentId: moved.parentId });
                publish(intl.formatMessage(messages.movedTo, { name: album.name, destination }));
              })
              .catch(() => {
                handles.current.get(album.id)?.focus();
                publish(
                  intl.formatMessage(messages.moveFailed, {
                    name: album.name,
                    reason: intl.formatMessage(messages.unexpectedFailure),
                  }),
                );
              });
            return;
          }
          const next = move(byId, displayOrder, album.id, drop.position);
          const from = placementIn(originRef.current, album.id).position;
          const { position: to, total: count } = placementIn(next, album.id);
          commit(album, next, commandFor(from, to, count));
        },
      };
    },
    invalidZoneProps: {
      onDragOver: (event) => {
        if (
          !hasAlbumReorderDrag(event.dataTransfer) ||
          (event.target instanceof Element && event.target.closest('.ovl-sidebar__albumrow') !== null)
        )
          return;
        event.dataTransfer.dropEffect = 'none';
        setDropTarget(null);
        dropRef.current = null;
        setInvalid(true);
      },
      onDragLeave: (event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setInvalid(false);
      },
    },
  };
}
