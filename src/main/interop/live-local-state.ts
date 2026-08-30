import { liveLocalRuntimeStateSchema, type LiveLocalRuntimeState } from '../../shared/interop/live-local-runtime.js';

let current: LiveLocalRuntimeState = {
  status: 'unavailable',
  operation: null,
  operationId: null,
  remoteSessionId: null,
  retryable: true,
};

export function liveLocalRuntimeState(): LiveLocalRuntimeState {
  return current;
}

export function setLiveLocalRuntimeState(state: LiveLocalRuntimeState): LiveLocalRuntimeState {
  current = liveLocalRuntimeStateSchema.parse(state);
  return current;
}
