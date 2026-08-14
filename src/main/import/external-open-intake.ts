import { isAbsolute, resolve } from 'node:path';

const MAX_PENDING_PATHS = 100_000;

export interface IntakeScheduler {
  readonly set: (task: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface ExternalOpenIntakeOptions {
  readonly deliver: (paths: readonly string[]) => void;
  readonly attention?: (() => void) | undefined;
  readonly delayMs?: number | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly scheduler?: IntakeScheduler | undefined;
}

const defaultScheduler: IntakeScheduler = {
  set: (task, delayMs) => setTimeout(task, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function openPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' || platform === 'darwin' ? path.toLocaleLowerCase('en-US') : path;
}

export function normalizeOpenPaths(paths: readonly string[], cwd: string, platform: NodeJS.Platform = process.platform): readonly string[] {
  const normalized = new Map<string, string>();
  for (const candidate of paths) {
    const trimmed = candidate.trim();
    if (trimmed === '' || (!isAbsolute(trimmed) && trimmed.startsWith('-'))) continue;
    const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
    normalized.set(openPathKey(absolute, platform), absolute);
  }
  return [...normalized.values()];
}

/** Electron argv includes executable + app path in dev, executable only when
 * packaged. Strip those launch arguments before forwarding document paths. */
export function commandLineOpenPaths(
  argv: readonly string[],
  packaged: boolean,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return normalizeOpenPaths(argv.slice(packaged ? 1 : 2), cwd, platform);
}

/** Coalesces hundreds of OS open-file events into one renderer delivery and
 * holds them across cold start, renderer reload, and app-lock closure. */
export class ExternalOpenIntake {
  private readonly pending = new Map<string, string>();
  private readonly platform: NodeJS.Platform;
  private readonly scheduler: IntakeScheduler;
  private readonly delayMs: number;
  private timer: unknown;
  private ready = false;
  private authorized = false;
  private closed = false;

  constructor(private readonly options: ExternalOpenIntakeOptions) {
    this.platform = options.platform ?? process.platform;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.delayMs = options.delayMs ?? 250;
  }

  enqueue(paths: readonly string[], cwd = process.cwd()): void {
    if (this.closed) return;
    const normalized = normalizeOpenPaths(paths, cwd, this.platform);
    for (const path of normalized) {
      if (this.pending.size >= MAX_PENDING_PATHS) break;
      this.pending.set(openPathKey(path, this.platform), path);
    }
    if (normalized.length > 0) this.options.attention?.();
    this.arm(this.delayMs);
  }

  setAuthorized(authorized: boolean): void {
    this.authorized = authorized;
    if (!authorized) this.rendererUnavailable();
    else this.arm(0);
  }

  rendererReady(): void {
    this.ready = true;
    this.arm(0);
  }

  rendererUnavailable(): void {
    this.ready = false;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) this.scheduler.clear(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  stats(): { readonly pending: number; readonly ready: boolean; readonly authorized: boolean } {
    return { pending: this.pending.size, ready: this.ready, authorized: this.authorized };
  }

  private arm(delayMs: number): void {
    if (this.closed || this.pending.size === 0) return;
    if (this.timer !== undefined) this.scheduler.clear(this.timer);
    this.timer = this.scheduler.set(() => {
      this.timer = undefined;
      this.flush();
    }, delayMs);
  }

  private flush(): void {
    if (!this.ready || !this.authorized || this.pending.size === 0) return;
    const paths = [...this.pending.values()];
    this.pending.clear();
    this.options.deliver(paths);
  }
}
