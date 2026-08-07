import path from 'node:path';

import type { NativeDragBridge, NativeDragStartInput } from './native-drag-bridge.js';

/** Unpackaged E2E receiver: exercises renderer selection and real decrypt/write
 * without pretending Chromium can emulate an AppKit file-promise receiver. */
export class TestNativeDragBridge implements NativeDragBridge {
  private generation = 0;
  private closed = false;

  constructor(private readonly destination: string) {
    if (!path.isAbsolute(destination)) throw new Error('native drag test destination must be absolute');
  }

  status() {
    return this.closed ? ({ available: false, reason: 'native-unavailable' } as const) : ({ available: true, reason: null } as const);
  }

  start(input: NativeDragStartInput): boolean {
    if (this.closed) return false;
    const generation = (this.generation += 1);
    void Promise.all(
      input.items.map((item) =>
        generation === this.generation
          ? input.materialize({ token: item.token, destinationPath: path.join(this.destination, item.fileName) })
          : Promise.reject(new Error('drag cancelled')),
      ),
    )
      .catch(() => undefined)
      .finally(input.ended);
    return true;
  }

  cancelAll(): void {
    this.generation += 1;
  }

  close(): void {
    this.closed = true;
    this.cancelAll();
  }
}
