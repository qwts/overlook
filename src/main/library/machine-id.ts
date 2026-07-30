import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Stable same-machine identity for the library lock (#842). Hostnames drift
// with network state (`.local` ↔ `.lan`, DHCP-supplied names, VPNs), so
// staleness judgment keys on a hardware/OS-install identifier instead:
// IOPlatformUUID on macOS, MachineGuid on Windows, /etc/machine-id on Linux.
// Unavailable → undefined, and callers fall back to the conservative
// hostname comparison.

const PROBE_TIMEOUT_MS = 5_000;

function probe(): string | undefined {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
      return /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(out)?.[1];
    }
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', String.raw`HKLM\SOFTWARE\Microsoft\Cryptography`, '/v', 'MachineGuid'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
      });
      return /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(out)?.[1];
    }
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const value = readFileSync(path, 'utf8').trim();
        if (value !== '') return value;
      } catch {
        // Try the next well-known location.
      }
    }
  } catch {
    // Probe failure degrades to hostname comparison, never worse.
  }
  return undefined;
}

let cached: string | null | undefined;

/** The machine's stable identity, or undefined when no probe succeeds.
 * Probed once per process; the value cannot change while running. */
export function machineId(): string | undefined {
  cached ??= probe() ?? null;
  return cached ?? undefined;
}
