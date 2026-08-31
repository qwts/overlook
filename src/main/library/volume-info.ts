import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Destination-volume classification (#483, ADR-0022 §5 / ADR-0017 §5).
// Parses `mount` output — `/dev/disk3s1 on /Volumes/X (apfs, local, ...)` —
// and picks the deepest mount point containing the path. FAT32 (`msdos`)
// blocks: its 4 GB file cap silently truncates large originals. Network
// filesystems warn-don't-block per ADR-0017 §5 (advisory locks cannot be
// verified across hosts and database safety is not guaranteed).

const NETWORK_FSTYPES = new Set(['smbfs', 'nfs', 'afpfs', 'webdav', 'cifs']);
const BLOCKED_FSTYPES: Record<string, string> = {
  msdos: 'FAT32 cannot hold files over 4 GB — format the disk as APFS or exFAT',
};

export interface VolumeClassification {
  readonly fstype: string | null;
  /** Human-readable objection — the ADR-0022 §5 'unsupported-filesystem' refusal. */
  readonly blocked: string | null;
  /** ADR-0017 §5 unsupported-but-not-blocked: surfaced as a Review warning. */
  readonly network: boolean;
}

interface MountEntry {
  readonly mountPoint: string;
  readonly fstype: string;
}

export function parseMountOutput(output: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of output.split('\n')) {
    const match = /^.+? on (.+) \(([^,)]+)[,)]/u.exec(line);
    const mountPoint = match?.[1];
    const fstype = match?.[2];
    if (mountPoint !== undefined && fstype !== undefined) {
      entries.push({ mountPoint, fstype: fstype.trim() });
    }
  }
  return entries;
}

export function classifyForMounts(entries: readonly MountEntry[], target: string): VolumeClassification {
  // `mount` reports POSIX paths even when these pure parser tests execute on a
  // Windows runner. Preserve that path grammar instead of rewriting `/Volumes`
  // beneath the current Windows drive.
  const resolved = target.startsWith('/') ? path.posix.resolve(target) : path.resolve(target);
  let best: MountEntry | null = null;
  for (const entry of entries) {
    const inside = resolved === entry.mountPoint || resolved.startsWith(entry.mountPoint === '/' ? '/' : `${entry.mountPoint}/`);
    if (inside && (best === null || entry.mountPoint.length > best.mountPoint.length)) best = entry;
  }
  if (best === null) return { fstype: null, blocked: null, network: false };
  return {
    fstype: best.fstype,
    blocked: BLOCKED_FSTYPES[best.fstype] ?? null,
    network: NETWORK_FSTYPES.has(best.fstype),
  };
}

/** Live probe (darwin/linux `mount`); a probe failure classifies as unknown —
 * preflight then relies on its other checks rather than refusing blind. */
export function classifyVolume(target: string): VolumeClassification {
  try {
    return classifyForMounts(parseMountOutput(execFileSync('mount', { encoding: 'utf8' })), target);
  } catch {
    return { fstype: null, blocked: null, network: false };
  }
}
