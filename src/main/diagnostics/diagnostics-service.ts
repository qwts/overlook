import type { AppSettings } from '../../shared/settings/settings.js';
import { ZodError } from 'zod';
import type { DiagnosticsQueue } from './diagnostics-queue.js';
import { type QueuedDiagnostic } from './diagnostics-queue.js';
import type { DiagnosticEvent } from './event-contract.js';
import { writeDiagnosticsExport } from './diagnostics-export.js';

export type DiagnosticOccurrence = Pick<DiagnosticEvent, 'kind'> &
  Partial<Pick<DiagnosticEvent, 'reason' | 'exitCode' | 'phase' | 'failureReason' | 'messagePreview' | 'missingCount' | 'corruptCount'>>;

export type DiagnosticsFailureCode = 'invalid-event' | 'custody-unavailable';

export interface DiagnosticsServiceOptions {
  readonly queue: DiagnosticsQueue;
  readonly settings: () => Pick<AppSettings, 'shareDiagnostics'>;
  readonly eventId: () => string;
  readonly now: () => Date;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly failure?: (code: DiagnosticsFailureCode) => void;
}

/** Owns the consent boundary. Capture sites provide only a closed process-health
 * vocabulary; this service constructs the complete event and never accepts an
 * Error, message, stack, path, renderer URL, WebContents, or arbitrary context. */
export class DiagnosticsService {
  private readonly options: DiagnosticsServiceOptions;

  constructor(options: DiagnosticsServiceOptions) {
    this.options = options;
  }

  record(occurrence: DiagnosticOccurrence): boolean {
    const consented = this.options.settings().shareDiagnostics;
    if (!consented) {
      this.options.queue.purge();
      return false;
    }
    try {
      return this.options.queue.enqueue(true, {
        schemaVersion: 1,
        eventId: this.options.eventId(),
        capturedAt: this.options.now().toISOString(),
        appVersion: this.options.appVersion,
        platform: this.options.platform,
        arch: this.options.arch,
        ...occurrence,
      });
    } catch (error) {
      this.options.failure?.(error instanceof ZodError ? 'invalid-event' : 'custody-unavailable');
      return false;
    }
  }

  reconcileConsent(): number {
    try {
      return this.options.queue.list(this.options.settings().shareDiagnostics).length;
    } catch {
      this.options.failure?.('custody-unavailable');
      return 0;
    }
  }

  list(): readonly QueuedDiagnostic[] {
    try {
      return this.options.queue.list(this.options.settings().shareDiagnostics);
    } catch {
      this.options.failure?.('custody-unavailable');
      return [];
    }
  }

  remove(eventId: string): boolean {
    const exists = this.list().some((entry) => entry.event.eventId === eventId);
    this.options.queue.remove(eventId);
    return exists;
  }

  purge(): number {
    const count = this.list().length;
    this.options.queue.purge();
    return count;
  }

  export(destination: string, eventIds: readonly string[]): number {
    const queued = new Map(this.list().map((report) => [report.event.eventId, report]));
    const reports = eventIds.map((eventId) => {
      const report = queued.get(eventId);
      if (report === undefined) throw new Error('reviewed diagnostic is no longer available');
      return report;
    });
    writeDiagnosticsExport(destination, reports);
    return reports.length;
  }
}
