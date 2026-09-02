export const activityEventTypes = [
  'import.completed',
  'album.created',
  'album.renamed',
  'album.deleted',
  'album.reordered',
  'album.visibility-changed',
  'album.moved',
  'album.tags-changed',
  'album.membership-added',
  'album.membership-removed',
  'album.membership-moved',
  'board.layout-changed',
  'photo.favorite-changed',
  'photo.trashed',
  'photo.restored',
  'photo.exported',
  'photo.purged',
  'command.undone',
  'command.redone',
  'command.compensated',
  'activity.pruned',
] as const;

export type ActivityEventType = (typeof activityEventTypes)[number];
export type ActivityActorClass = 'local-user' | 'system' | 'interop-peer' | 'recovery';
export type ActivityOutcome = 'succeeded' | 'partial' | 'failed';

export interface ActivityEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly operationId: string;
  readonly eventType: ActivityEventType;
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly actorClass: ActivityActorClass;
  readonly rootCorrelationId: string;
  readonly causationEventId: string | null;
  readonly entityIds: readonly string[];
  readonly outcome: ActivityOutcome;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly supersedesEventId: string | null;
}

export interface ActivityPage {
  readonly events: readonly ActivityEvent[];
  readonly nextCursor: number | null;
}

export interface ActivityAppend {
  readonly eventId: string;
  readonly operationId: string;
  readonly eventType: ActivityEventType;
  readonly occurredAt: string;
  readonly actorClass?: ActivityActorClass | undefined;
  readonly rootCorrelationId?: string | undefined;
  readonly causationEventId?: string | null | undefined;
  readonly entityIds?: readonly string[] | undefined;
  readonly outcome: ActivityOutcome;
  readonly payload?: Readonly<Record<string, string | number | boolean | null>> | undefined;
  readonly supersedesEventId?: string | null | undefined;
}
