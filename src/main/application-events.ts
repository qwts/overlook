import { broadcast } from './app-window.js';
import { createApplicationEventBus } from './application-event-bus.js';

const send = (name: string, payload: unknown): void => broadcast((win) => win.webContents.send(name, payload));

export const applicationEvents = createApplicationEventBus(send);
