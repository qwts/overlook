import { z } from 'zod';

export const diagnosticEventIdSchema = z.string().uuid();

export const diagnosticEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: diagnosticEventIdSchema,
    capturedAt: z.string().datetime({ offset: true }),
    appVersion: z.string().min(1).max(32),
    platform: z.enum(['darwin', 'win32', 'linux']),
    arch: z.enum(['arm64', 'x64']),
    kind: z.enum([
      'main-process-runtime-error',
      'renderer-process-gone',
      'child-process-gone',
      'renderer-unresponsive',
      'restore-verify-failed',
      'restore-failed',
    ]),
    reason: z
      .enum(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'])
      .optional(),
    exitCode: z.number().int().optional(),
    // Restore diagnostics (#947): allowlisted, truncated fields only.
    phase: z.enum(['discovering', 'downloading', 'rebuilding', 'activating', 'verify-scan']).optional(),
    failureReason: z
      .enum(['auth', 'offline', 'disk-space', 'corrupt', 'wrong-key', 'unsupported', 'destructive-authorization', 'cancelled', 'io'])
      .optional(),
    messagePreview: z.string().max(200).optional(),
    missingCount: z.number().int().nonnegative().optional(),
    corruptCount: z.number().int().nonnegative().optional(),
  })
  .strict();

export type DiagnosticEvent = z.output<typeof diagnosticEventSchema>;

export function serializeDiagnosticEvent(input: unknown): string {
  return JSON.stringify(diagnosticEventSchema.parse(input));
}

export function deserializeDiagnosticEvent(serialized: string): DiagnosticEvent {
  return diagnosticEventSchema.parse(JSON.parse(serialized));
}
