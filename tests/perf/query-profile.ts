import { writeFileSync } from 'node:fs';
import type { Session } from 'node:inspector/promises';
import type { ElectronApplication } from '@playwright/test';

type ProfileState = typeof globalThis & { overlookPerfSession?: Session };

/** Opt-in diagnostic only: profiling perturbs timings, so these runs are not baselines. */
export async function profileQueries<T>(app: ElectronApplication, operation: () => Promise<T>): Promise<T> {
  if (process.env['OVERLOOK_PERF_PROFILE'] !== '1') return operation();
  console.log('[perf] DIAGNOSTIC CPU PROFILE ENABLED: timings are not baseline evidence');
  await app.evaluate(async () => {
    const { Session } = process.getBuiltinModule('node:inspector/promises');
    const session = new Session();
    session.connect();
    try {
      await session.post('Profiler.enable');
      await session.post('Profiler.start');
      (globalThis as ProfileState).overlookPerfSession = session;
    } catch (error) {
      session.disconnect();
      throw error;
    }
  });
  try {
    return await operation();
  } finally {
    const profile = await app.evaluate(async () => {
      const state = globalThis as ProfileState;
      const session = state.overlookPerfSession;
      if (session === undefined) throw new Error('missing main-process CPU profile session');
      try {
        return (await session.post('Profiler.stop')).profile;
      } finally {
        delete state.overlookPerfSession;
        session.disconnect();
      }
    });
    writeFileSync('test-results/perf-query-profile.cpuprofile', JSON.stringify(profile));
  }
}
