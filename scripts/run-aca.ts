import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXECUTION_MS = 120_000;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

interface RunOptions {
  readonly check: string;
  readonly cliPath: string;
  readonly timeoutMs?: number;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

function validReport(value: unknown, check: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Record<string, unknown>;
  return (
    report['check'] === check &&
    typeof report['provider'] === 'string' &&
    typeof report['model'] === 'string' &&
    Array.isArray(report['verdicts']) &&
    report['verdicts'].every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const verdict = entry as Record<string, unknown>;
      return typeof verdict['file'] === 'string' && ['pass', 'warn', 'fail'].includes(String(verdict['verdict']));
    })
  );
}

/** The CLI owns judgments; this boundary owns complete execution, not per-call timeouts. */
export async function runAca(options: RunOptions): Promise<number> {
  const timeoutMs = options.timeoutMs ?? EXECUTION_MS;
  if (process.platform === 'win32' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > EXECUTION_MS) {
    options.stderr('ACA requires a POSIX runner and an execution budget of at most 120000ms.\n');
    return 2;
  }
  const started = performance.now();
  return new Promise<number>((resolveResult) => {
    const child = spawn(process.execPath, [options.cliPath, options.check, '--base', 'origin/main', '--json'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let output = '';
    let bytes = 0;
    let refused: number | undefined;
    const stop = (code: number, reason: string): void => {
      if (refused !== undefined) return;
      refused = code;
      options.stderr(`${options.check}: ${reason}; no complete report published.\n`);
      if (child.pid !== undefined) {
        try {
          // Includes git helpers and any provider subprocesses, even if the CLI exits first.
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') options.stderr(`ACA termination failed: ${String(error)}\n`);
        }
      }
    };
    const timer = setTimeout(
      () => stop(124, `execution timed out after ${String(timeoutMs)}ms`),
      Math.max(0, timeoutMs - (performance.now() - started)),
    );
    const interrupted = (): void => stop(130, 'execution interrupted');
    const terminated = (): void => stop(143, 'execution cancelled');
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', terminated);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REPORT_BYTES) stop(78, 'report exceeded the output budget');
      else if (refused === undefined) output += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => options.stderr(chunk.toString('utf8')));
    child.on('error', (error) => stop(78, `could not start judge: ${error.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupted);
      process.removeListener('SIGTERM', terminated);
      options.stderr(`${options.check}: execution finished in ${String(Math.round(performance.now() - started))}ms.\n`);
      if (refused !== undefined) return resolveResult(refused);
      let report: unknown;
      try {
        report = JSON.parse(output);
      } catch {
        // Advisory ACA can exit zero for missing credentials. No JSON report is not a pass.
      }
      if (code !== 0 || !validReport(report, options.check)) {
        options.stderr(`${options.check}: unavailable or incomplete judgment (exit ${String(code)}).\n`);
        return resolveResult(78);
      }
      options.stdout(`${output.trim()}\n`);
      resolveResult(0);
    });
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runAca({
    check: process.argv[2] ?? '',
    cliPath: resolve('.aca/src/cli.ts'),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
