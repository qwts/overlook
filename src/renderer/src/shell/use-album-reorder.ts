import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import type { CommandId } from '../../../shared/commands/registry.js';
import type { AlbumSummary } from '../../../shared/library/types.js';
import { useAnnouncer } from '../components/LiveAnnouncer';
import { beginAlbumReorderDrag, endAlbumReorderDrag, hasAlbumReorderDrag, readAlbumReorderDrag } from './album-reorder-drag-session';

export type AlbumReorderCommand = Extract<CommandId, `album.reorder.${string}`>;

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
  handle: { id: 'album.reorder.handle', defaultMessage: 'Reorder {name}, position {position} of {total}' },
  movingHandle: {
    id: 'album.reorder.handleMoving',
    defaultMessage: 'Moving {name}, position {position} of {total}. Arrow keys move, Space drops, Escape cancels.',
  },
});

const ids = (albums: readonly AlbumSummary[]): string[] => albums.map(({ id }) => id);
const sameOrder = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

function move(order: readonly string[], albumId: string, position: number): string[] {
  const next = [...order];
  const current = next.indexOf(albumId);
  if (current === -1) return next;
  next.splice(current, 1);
  next.splice(Math.max(0, Math.min(position, next.length)), 0, albumId);
  return next;
}

function commandFor(from: number, to: number, total: number): AlbumReorderCommand {
  if (to === 0) return 'album.reorder.top';
  if (to === total - 1) return 'album.reorder.bottom';
  return to < from ? 'album.reorder.up' : 'album.reorder.down';
}

export function useAlbumReorder<T extends AlbumSummary>(
  albums: readonly T[],
): {
  readonly albums: readonly T[];
  readonly grabbedId: string | null;
  readonly draggingId: string | null;
  readonly invalid: boolean;
  readonly instructionId: string;
  readonly moveByCommand: (album: AlbumSummary, command: AlbumReorderCommand) => void;
  readonly handleProps: (album: AlbumSummary) => {
    readonly draggable: true;
    readonly disabled: boolean;
    readonly 'aria-label': string;
    readonly 'aria-describedby': string;
    readonly 'aria-grabbed': boolean | undefined;
    readonly onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
    readonly onDragEnd: () => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  };
  readonly rowProps: (album: AlbumSummary) => {
    readonly onDragEnter: (event: DragEvent<HTMLLIElement>) => void;
    readonly onDragOver: (event: DragEvent<HTMLLIElement>) => void;
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
  const originRef = useRef<readonly string[]>(incomingOrder);
  const interactionSignatureRef = useRef('');
  const pointerCommittedRef = useRef(false);
  const displayOrder = previewOrder ?? incomingOrder;
  const byId = new Map(albums.map((album) => [album.id, album]));
  const orderedAlbums = displayOrder.flatMap((id) => {
    const album = byId.get(id);
    return album === undefined ? [] : [album];
  });
  const publish = useCallback((message: string): void => announce(message, 'polite', 'album-reorder'), [announce]);

  const signature = albums.map(({ id, name }) => `${id}\u0000${name}`).join('\u0001');
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
        endAlbumReorderDrag();
        publish(intl.formatMessage(messages.changed));
      }
      setPreviewOrder(null);
    });
    return () => {
      active = false;
    };
  }, [draggingId, grabbedId, incomingOrder, intl, previewOrder, publish, signature]);

  const announcePosition = (album: AlbumSummary, order: readonly string[]): void => {
    publish(intl.formatMessage(messages.position, { name: album.name, position: order.indexOf(album.id) + 1, total: order.length }));
  };

  const commit = (album: AlbumSummary, next: readonly string[], commandId: AlbumReorderCommand): void => {
    const position = next.indexOf(album.id);
    const unchanged = sameOrder(originRef.current, next);
    setGrabbedId(null);
    setDraggingId(null);
    setInvalid(false);
    endAlbumReorderDrag();
    if (unchanged) {
      setPreviewOrder(null);
      publish(intl.formatMessage(messages.stayed, { name: album.name, position: position + 1, total: next.length }));
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

  const begin = (album: AlbumSummary): void => {
    originRef.current = displayOrder;
    interactionSignatureRef.current = signature;
    setGrabbedId(album.id);
    publish(intl.formatMessage(messages.grabbed, { name: album.name }));
  };

  const moveByCommand = (album: AlbumSummary, command: AlbumReorderCommand): void => {
    const order = incomingOrder;
    const current = order.indexOf(album.id);
    const target =
      command === 'album.reorder.top'
        ? 0
        : command === 'album.reorder.bottom'
          ? order.length - 1
          : command === 'album.reorder.up'
            ? Math.max(0, current - 1)
            : Math.min(order.length - 1, current + 1);
    originRef.current = order;
    commit(album, move(order, album.id, target), command);
  };

  return {
    albums: orderedAlbums,
    grabbedId,
    draggingId,
    invalid,
    instructionId: 'album-reorder-instructions',
    moveByCommand,
    handleProps: (album) => {
      const position = displayOrder.indexOf(album.id);
      const grabbed = grabbedId === album.id;
      return {
        draggable: true,
        disabled: displayOrder.length < 2,
        'aria-label': intl.formatMessage(grabbed ? messages.movingHandle : messages.handle, {
          name: album.name,
          position: position + 1,
          total: displayOrder.length,
        }),
        'aria-describedby': 'album-reorder-instructions',
        'aria-grabbed': grabbed ? true : undefined,
        onDragStart: (event) => {
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
            const originalPosition = originRef.current.indexOf(album.id);
            setPreviewOrder(null);
            setDraggingId(null);
            setInvalid(false);
            endAlbumReorderDrag();
            publish(
              intl.formatMessage(messages.cancelled, {
                name: album.name,
                position: originalPosition + 1,
                total: originRef.current.length,
              }),
            );
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
            const originalPosition = originRef.current.indexOf(album.id);
            setPreviewOrder(null);
            setGrabbedId(null);
            publish(
              intl.formatMessage(messages.cancelled, {
                name: album.name,
                position: originalPosition + 1,
                total: originRef.current.length,
              }),
            );
            return;
          }
          if (event.key === ' ' || event.key === 'Enter' || event.key === 'Tab') {
            if (event.key !== 'Tab') {
              event.preventDefault();
              event.stopPropagation();
            }
            const from = originRef.current.indexOf(album.id);
            const to = displayOrder.indexOf(album.id);
            commit(album, displayOrder, commandFor(from, to, displayOrder.length));
            return;
          }
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const current = displayOrder.indexOf(album.id);
          const target =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? displayOrder.length - 1
                : event.key === 'ArrowUp'
                  ? Math.max(0, current - 1)
                  : Math.min(displayOrder.length - 1, current + 1);
          if (target === current) {
            publish(intl.formatMessage(target === 0 ? messages.alreadyFirst : messages.alreadyLast, { name: album.name }));
            return;
          }
          const next = move(displayOrder, album.id, target);
          setPreviewOrder(next);
          announcePosition(album, next);
        },
      };
    },
    rowProps: (target) => {
      const accept = (event: DragEvent<HTMLLIElement>): string | null => {
        if (!hasAlbumReorderDrag(event.dataTransfer)) return null;
        const payload = readAlbumReorderDrag(event.dataTransfer);
        if (payload === null) return null;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setInvalid(false);
        return payload.albumId;
      };
      const preview = (event: DragEvent<HTMLLIElement>): void => {
        const albumId = accept(event);
        if (albumId === null) return;
        const source = displayOrder.indexOf(albumId);
        const over = displayOrder.indexOf(target.id);
        const before = event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2;
        const position = before ? (over > source ? over - 1 : over) : over >= source ? over : over + 1;
        setPreviewOrder(move(displayOrder, albumId, position));
      };
      return {
        onDragEnter: preview,
        onDragOver: preview,
        onDrop: (event) => {
          const albumId = accept(event);
          const album = albumId === null ? undefined : albums.find(({ id }) => id === albumId);
          if (album === undefined) return;
          const from = originRef.current.indexOf(album.id);
          const to = displayOrder.indexOf(album.id);
          pointerCommittedRef.current = true;
          commit(album, displayOrder, commandFor(from, to, displayOrder.length));
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
        setInvalid(true);
      },
      onDragLeave: (event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setInvalid(false);
      },
    },
  };
}
