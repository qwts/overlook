import { app } from 'electron';
import path from 'node:path';

import { registerThemeHandlers } from '../ipc.js';
import { getSettingsStore } from '../settings/settings-runtime.js';
import { ThemeService } from './theme-service.js';

export function installThemeRuntime(): () => void {
  const service = new ThemeService(path.join(app.getPath('userData'), 'themes'), getSettingsStore());
  if (process.argv.includes('--reset-theme')) service.reset();
  registerThemeHandlers(service);
  app.once('will-quit', () => service.dispose());
  return () => service.reset();
}
