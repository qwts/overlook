import { z } from 'zod';

import {
  LiveLocalError,
  parseLiveLocalBootstrapRequest,
  windowsNamedPipeForUser,
  type LiveLocalBootstrapRequest,
  type LiveLocalBootstrapResult,
  type LiveLocalBootstrapState,
} from './live-local-security.js';
import { liveLocalRuntimeDirectory, startUnixLiveLocalControlServer, type LiveLocalControlServer } from './live-local-control.js';
import { LiveLocalSessionListener, type LiveLocalAcceptedSession } from './live-local-session.js';
import { createWindowsLiveLocalPlatform, type WindowsLiveLocalPlatform } from './windows-live-local.js';

const sessionControlSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.enum(['heartbeat', 'cancel']),
  })
  .strict();

export interface LiveLocalBridgeOptions {
  readonly platform: NodeJS.Platform;
  readonly profileDirectory: string;
  readonly temporaryDirectory: string;
  readonly expectedExtensionId: string;
  readonly bootstrapState: (request: LiveLocalBootstrapRequest) => LiveLocalBootstrapState;
  readonly windows?: WindowsLiveLocalPlatform;
}

async function runControlOnlySession(session: LiveLocalAcceptedSession): Promise<void> {
  for (;;) {
    const frame = await session.read(64 * 1024);
    if (frame.opcode === 9) {
      session.sendPong(frame.payload);
      continue;
    }
    if (frame.opcode === 8) return;
    if (frame.opcode !== 1) {
      session.close(1003);
      return;
    }
    const control = sessionControlSchema.parse(JSON.parse(frame.payload.toString('utf8')) as unknown);
    if (control.type === 'cancel') {
      session.close();
      return;
    }
    session.sendText({ schemaVersion: 1, type: 'heartbeat-ack' });
  }
}

/** Production ADR-0029 bootstrap composition. The control endpoint belongs to
 * the desktop lifecycle; the loopback listener exists only while capability
 * authority or an authenticated session exists. #545 replaces the control-
 * only session handler with the encrypted durable transport. */
export class LiveLocalBridge {
  private control: LiveLocalControlServer | null = null;
  private readonly sessions: LiveLocalSessionListener;
  private suspended = false;

  constructor(private readonly options: LiveLocalBridgeOptions) {
    this.sessions = new LiveLocalSessionListener({
      expectedExtensionId: options.expectedExtensionId,
      onSession: runControlOnlySession,
    });
  }

  async start(): Promise<boolean> {
    if (this.control !== null) return true;
    if (this.options.platform === 'darwin') {
      const runtimeDirectory = liveLocalRuntimeDirectory(this.options.profileDirectory, this.options.temporaryDirectory);
      this.control = await startUnixLiveLocalControlServer(runtimeDirectory, (value) => this.bootstrap(value));
    } else if (this.options.platform === 'win32') {
      const windows = this.options.windows ?? createWindowsLiveLocalPlatform();
      const contract = windowsNamedPipeForUser(windows.currentUserSid());
      this.control = await windows.start(contract.path, contract.sddl, (value) => this.bootstrap(value));
    } else return false;
    return true;
  }

  async lock(): Promise<void> {
    this.suspended = true;
    await this.sessions.closeSessions();
  }

  unlock(): void {
    this.suspended = false;
  }

  async close(): Promise<void> {
    const control = this.control;
    this.control = null;
    await this.sessions.close();
    await control?.close();
  }

  private async bootstrap(value: unknown): Promise<LiveLocalBootstrapResult> {
    const request = parseLiveLocalBootstrapRequest(value);
    if (request.extensionId !== this.options.expectedExtensionId)
      throw new LiveLocalError('Live local bootstrap rejected the extension authority.', 'wrong-authority');
    const state = this.suspended ? 'locked' : this.options.bootstrapState(request);
    if (state !== 'running') return { schemaVersion: 1, state };
    return this.sessions.issue(request);
  }
}
