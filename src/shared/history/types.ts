import type { CommandId } from '../commands/registry.js';

export type CommandClassification = 'immediately-reversible' | 'conditionally-reversible' | 'compensating-only' | 'irreversible';
export type CapabilityStatus = 'available' | 'conditional' | 'pending' | 'expired' | 'unavailable' | 'irreversible';
export type CapabilityReason =
  | 'ready'
  | 'empty-stack'
  | 'expired'
  | 'state-changed'
  | 'resource-missing'
  | 'path-occupied'
  | 'permission-denied'
  | 'insufficient-space'
  | 'bytes-unavailable'
  | 'irreversible';

export type InverseParameters =
  | {
      readonly kind: 'favorite';
      readonly photoId: string;
      readonly before: boolean;
      readonly after: boolean;
    }
  | {
      readonly kind: 'favorites';
      readonly changes: readonly {
        readonly photoId: string;
        readonly before: boolean;
        readonly after: boolean;
      }[];
    }
  | {
      readonly kind: 'album-membership';
      readonly albumId: string;
      readonly photoIds: readonly string[];
      readonly before: 'present' | 'absent';
      readonly after: 'present' | 'absent';
    }
  | {
      readonly kind: 'trash';
      readonly photoIds: readonly string[];
      readonly before: 'live' | 'trashed';
      readonly after: 'live' | 'trashed';
    }
  | {
      readonly kind: 'album-order';
      readonly albumId: string;
      readonly before: readonly string[];
      readonly after: readonly string[];
    }
  | {
      // Moodboard layout edit (#515 / #695). before/after are canonical
      // serialized boards; one command per gesture (the renderer coalesces a
      // gesture into a single debounced save). Undo restores `before`.
      readonly kind: 'board-layout';
      readonly boardId: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: 'move-compensation';
      readonly photoId: string;
      readonly contentHash: string;
      readonly sourcePath: string;
      readonly byteCharge: number;
      readonly parentIdentity: string;
    };

export interface CommandRecordDraft {
  readonly recordId: string;
  readonly activityEventId: string;
  readonly commandId: CommandId;
  readonly classification: CommandClassification;
  readonly inverse: InverseParameters;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sensitiveExpiresAt?: string | null;
  readonly byteCharge?: number;
}

export interface CommandRecord extends Omit<CommandRecordDraft, 'sensitiveExpiresAt' | 'byteCharge'> {
  readonly sequence: number;
  readonly stack: 'undo' | 'redo' | 'discarded';
  readonly sensitiveExpiresAt: string | null;
  readonly byteCharge: number;
}

export interface CapabilitySnapshot {
  readonly recordId: string | null;
  readonly commandId: CommandId | null;
  readonly classification: CommandClassification | null;
  readonly status: CapabilityStatus;
  readonly reason: CapabilityReason;
  readonly expiresAt: string | null;
}

export interface HistoryStatus {
  readonly undo: CapabilitySnapshot;
  readonly redo: CapabilitySnapshot;
}

export interface HistoryExecutionResult {
  readonly applied: boolean;
  readonly direction: 'undo' | 'redo';
  readonly capability: CapabilitySnapshot;
}
