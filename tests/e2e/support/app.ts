import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';

import { mkE2eTmpDir } from './tmp-dir.js';

// Shared Electron launch/readiness/teardown fixture (#630). Every wall-clock
// wait in the launch and shutdown lifecycle runs through a named stage with
// its own bound, so a stall reports WHICH transition was missed (plus window/
// process state and recent renderer console output) instead of silently
// consuming the whole test budget. Teardown is bounded and force-kill-backed:
// a timed-out test can no longer leave app.close() hanging into Playwright's
// worker-teardown timeout, which used to replace the original failure with an
// unowned "Worker teardown timeout" error that kept the gate red even when
// the retry passed.

// Stage bounds. Generous relative to healthy runs (launch ≈1s, ready ≈1s on a
// dev machine) but far below any test budget, so a missed transition fails
// fast with a diagnosis. These are readiness bounds, not product timings — do
// not tune product behavior against them.
const LAUNCH_STAGE_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 10_000;

interface ConsoleEntry {
  readonly kind: string;
  readonly text: string;
}

const CONSOLE_TAIL = 20;

/**
 * Rolling diagnostics collected from every window of a launched app. Every
 * accessor is guarded: once the Electron process dies (fault-injection tests
 * kill it on purpose), the Playwright app handle throws internal TypeErrors
 * from any query, and diagnostics must never mask the failure they describe.
 */
class AppDiagnostics {
  private readonly entries: ConsoleEntry[] = [];

  constructor(private readonly app: ElectronApplication) {
    app.on('window', (page) => this.wire(page));
    for (const page of app.windows()) this.wire(page);
    const child = app.process();
    child.stdout?.on('data', (chunk: Buffer | string) => this.pushProcessOutput('main:stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => this.pushProcessOutput('main:stderr', chunk));
  }

  private wire(page: Page): void {
    page.on('console', (message) => this.push({ kind: message.type(), text: message.text() }));
    page.on('pageerror', (error) => this.push({ kind: 'pageerror', text: error.message }));
  }

  private push(entry: ConsoleEntry): void {
    this.entries.push(entry);
    if (this.entries.length > CONSOLE_TAIL) this.entries.shift();
  }

  private pushProcessOutput(kind: string, chunk: Buffer | string): void {
    for (const text of String(chunk).split(/\r?\n/u)) {
      if (text !== '') this.push({ kind, text });
    }
  }

  describe(exited: boolean): string {
    let windows = '<unavailable>';
    try {
      const urls = this.app.windows().map((page) => (page.isClosed() ? '<closed>' : page.url()));
      windows = `${String(urls.length)} ${JSON.stringify(urls)}`;
    } catch {
      // dead app handle — the process state line below still tells the story
    }
    const consoleTail = this.entries.map((entry) => `[${entry.kind}] ${entry.text}`).join('\n      ') || '<empty>';
    return [`windows=${windows}`, `process=${exited ? 'exited' : 'running'}`, `console tail:\n      ${consoleTail}`].join('\n    ');
  }
}

/**
 * Bound a lifecycle transition and label its failure with the stage that
 * stalled plus app/window/process state — the diagnosable alternative to a
 * bare "Test timeout of Nms exceeded".
 */
async function stage<T>(name: string, describe: (() => string) | null, timeoutMs: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const state = describe === null ? '' : `\n    ${describe()}`;
      reject(new Error(`E2E lifecycle stage "${name}" stalled after ${String(timeoutMs)}ms.${state}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    clearTimeout(timer);
  }
}

export interface LaunchSpec {
  /** Temp-dir prefix for a fresh isolated profile (mkE2eTmpDir). */
  readonly prefix?: string;
  /** Reuse an existing profile dir (relaunch flows) instead of a fresh one. */
  readonly userData?: string;
  /** Additional Electron argv, used for cold-start OS document-open flows. */
  readonly args?: readonly string[];
  /** Extra launch env (OVERLOOK_SEED, fault injection, …). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Test id that marks the renderer ready for this flow — 'virtual-grid' for
   * seeded libraries, 'restore-onboarding' for first-run, null when the test
   * asserts the boot surface itself.
   */
  readonly readyTestId?: string | null;
}

export interface LaunchedApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly userData: string;
  /** True once the Electron root process has exited (crash faults, close). */
  readonly hasExited: () => boolean;
  /** Resolves when the Electron root process exits. Captured at launch, so it is safe to await after a fault already killed the app. */
  readonly exited: Promise<void>;
  /**
   * Bounded, force-kill-backed close — the same shutdown fixture teardown
   * uses. Call it inside multi-launch loops (crash/recovery, relaunch flows)
   * so earlier instances do not stay alive across iterations; teardown skips
   * already-exited instances, so an explicit close is never double-closed.
   */
  readonly close: () => Promise<void>;
  /** Recent renderer and Electron-main diagnostics for a failed lifecycle assertion. */
  readonly describe: () => string;
}

interface TrackedApp {
  readonly app: ElectronApplication;
  readonly describe: () => string;
  readonly hasExited: () => boolean;
  readonly kill: () => void;
}

async function launchStages(spec: LaunchSpec, track: (tracked: TrackedApp) => void, testInfo: TestInfo): Promise<LaunchedApp> {
  if (spec.userData === undefined && spec.prefix === undefined)
    throw new Error('launchOverlook needs a prefix (fresh profile) or userData (relaunch)');
  const userData = spec.userData ?? mkE2eTmpDir(spec.prefix ?? 'overlook-e2e-');
  const app = await stage(
    'electron-launch',
    null,
    LAUNCH_STAGE_TIMEOUT_MS,
    electron.launch({
      args: ['.', ...(spec.args ?? [])],
      env: {
        ...process.env,
        OVERLOOK_USER_DATA: userData,
        OVERLOOK_INSECURE_KEYSTORE: '1',
        ...spec.env,
      },
    }),
  );
  // Capture the child process and its exit signal NOW: after the process dies
  // (fault injection, crash) the Playwright app handle throws from any query,
  // so nothing below may re-derive process state from `app` later.
  const child = app.process();
  let exitedFlag = false;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exitedFlag = true;
      resolve();
    });
  });
  const diagnostics = new AppDiagnostics(app);
  const describe = (): string => diagnostics.describe(exitedFlag);
  // Track for teardown BEFORE any further stage: a stall in first-window or
  // renderer-ready must still end with this instance closed or killed.
  const tracked: TrackedApp = { app, describe, hasExited: () => exitedFlag, kill: () => child.kill('SIGKILL') };
  track(tracked);
  const page = await stage('first-window', describe, LAUNCH_STAGE_TIMEOUT_MS, app.firstWindow());
  const readyTestId = spec.readyTestId === undefined ? 'virtual-grid' : spec.readyTestId;
  const launched: LaunchedApp = {
    app,
    page,
    userData,
    hasExited: () => exitedFlag,
    exited,
    close: () => closeApp(tracked, testInfo),
    describe,
  };
  if (readyTestId !== null) {
    await stage(
      `renderer-ready [${readyTestId}]`,
      describe,
      LAUNCH_STAGE_TIMEOUT_MS,
      page.getByTestId(readyTestId).waitFor({ timeout: LAUNCH_STAGE_TIMEOUT_MS + 1_000 }),
    );
  }
  return launched;
}

/**
 * Bounded, force-kill-backed close. Never lets a hung app.close() escalate
 * into the worker-teardown timeout: after the grace window the Electron
 * process tree is killed and the stall is reported — as a warning annotation
 * when the test already has a verdict, preserving the original failure.
 */
async function closeApp(tracked: TrackedApp, testInfo: TestInfo): Promise<void> {
  const { app, describe, hasExited, kill } = tracked;
  if (hasExited()) return;
  let stalled = false;
  await stage('app-close', describe, CLOSE_GRACE_MS, app.close()).catch(() => {
    stalled = true;
    kill();
  });
  if (stalled) {
    testInfo.annotations.push({
      type: 'warning',
      description: `app.close() stalled past ${String(CLOSE_GRACE_MS)}ms and was force-killed.\n    ${describe()}`,
    });
  }
}

interface OverlookFixtures {
  /**
   * Launch the app through the staged readiness contract. May be called more
   * than once per test (relaunch/crash flows); every launched instance is
   * closed in fixture teardown with the bounded close, in reverse order, even
   * when the test body times out.
   */
  launchOverlook: (spec: LaunchSpec) => Promise<LaunchedApp>;
}

export const test = base.extend<OverlookFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature; consuming any built-in fixture here (e.g. page) would launch a plain browser alongside the Electron app under test
  launchOverlook: async ({}, use, testInfo) => {
    const launched: TrackedApp[] = [];
    await use((spec) => launchStages(spec, (tracked) => launched.push(tracked), testInfo));
    for (const tracked of launched.reverse()) await closeApp(tracked, testInfo);
  },
});

export { expect };

/**
 * Synchronize an in-place renderer reload (active-library move, app-lock
 * relock): arm the navigation listener BEFORE triggering, then require the
 * renderer to re-reach its ready marker. Replaces the raced
 * `firstWindow()` + bare waitFor pattern that could observe the pre-reload
 * document and stall for the rest of the test budget (#630).
 */
export async function expectRendererReload<T>(
  launchedApp: LaunchedApp,
  trigger: () => Promise<T>,
  options: { readonly readyTestId?: string; readonly timeoutMs?: number } = {},
): Promise<T> {
  const { page } = launchedApp;
  const timeoutMs = options.timeoutMs ?? LAUNCH_STAGE_TIMEOUT_MS;
  const readyTestId = options.readyTestId ?? 'virtual-grid';
  const navigated = page.waitForEvent('framenavigated', { timeout: timeoutMs + 1_000 });
  // The trigger itself shares the stage bound: a trigger that never settles
  // (an IPC call severed mid-reload the catch didn't match) must fail with
  // the staged label, not stall here while the armed listener rejects
  // unobserved in the background.
  navigated.catch(() => undefined);
  const result = await stage(
    'renderer-reload [trigger + framenavigated]',
    null,
    timeoutMs,
    Promise.all([trigger(), navigated]).then(([value]) => value),
  );
  await stage(
    `renderer-ready-after-reload [${readyTestId}]`,
    null,
    timeoutMs,
    page.getByTestId(readyTestId).waitFor({ timeout: timeoutMs + 1_000 }),
  );
  return result;
}

/** Bounded wait for a fault-injected app process to actually exit. */
export function appExited(launchedApp: LaunchedApp, timeoutMs = LAUNCH_STAGE_TIMEOUT_MS): Promise<void> {
  return stage('process-exit', null, timeoutMs, launchedApp.exited);
}
