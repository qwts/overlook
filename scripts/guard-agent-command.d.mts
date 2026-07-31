export interface GuardVerdict {
  readonly allow: boolean;
  readonly reason?: string;
}

export function evaluateCommand(command: unknown): GuardVerdict;
