import { z } from 'zod';

import { settingsSchema } from '../settings/settings.js';
import { themeIdSchema, themeMetaSchema, themeValidationErrorSchema, themeWarningSchema } from '../theme/theme-file.js';
import type { ChannelDefinition } from './channels.js';

const defineChannel = <TRequest extends z.ZodType, TResponse extends z.ZodType>(
  name: string,
  request: TRequest,
  response: TResponse,
): ChannelDefinition<TRequest, TResponse> => ({ name, request, response });

const canonicalColorSchema = z.string().regex(/^rgb\([\d.]+% [\d.]+% [\d.]+%(?: \/ [\d.]+)?\)$/);

export const installedThemeSchema = z.object({
  id: themeIdSchema,
  meta: themeMetaSchema,
  warnings: z.array(themeWarningSchema).readonly(),
  swatches: z.array(canonicalColorSchema).max(6).readonly(),
});

export const applicableThemeSchema = z.object({
  id: themeIdSchema,
  meta: themeMetaSchema,
  tokens: z.record(z.string(), canonicalColorSchema),
  warnings: z.array(themeWarningSchema).readonly(),
});

export type InstalledTheme = z.output<typeof installedThemeSchema>;
export type ApplicableTheme = z.output<typeof applicableThemeSchema>;
export type ThemeImportResult = z.output<typeof importResultSchema>;

const importResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }),
  z.object({ status: z.literal('invalid'), errors: z.array(themeValidationErrorSchema).min(1).readonly() }),
  z.object({ status: z.literal('imported'), theme: installedThemeSchema }),
]);

export const themeChannels = {
  themeList: defineChannel(
    'theme:list',
    z.object({}),
    z.object({ themes: z.array(installedThemeSchema).readonly(), activeId: themeIdSchema.nullable() }),
  ),
  themePickImport: defineChannel('theme:pick-import', z.object({}), importResultSchema),
  themeImportPath: defineChannel('theme:import-path', z.object({ path: z.string().min(1).max(4096) }), importResultSchema),
  themeActive: defineChannel(
    'theme:active',
    z.object({}),
    z.object({ theme: applicableThemeSchema.nullable(), notice: z.enum(['missing', 'invalid']).nullable() }),
  ),
  themePreview: defineChannel(
    'theme:preview',
    z.object({ id: themeIdSchema }),
    z.object({ previewId: z.string().uuid(), expiresAt: z.number().int().positive(), theme: applicableThemeSchema }),
  ),
  themePreviewHealthy: defineChannel(
    'theme:preview-healthy',
    z.object({ previewId: z.string().uuid() }),
    z.object({ accepted: z.boolean() }),
  ),
  themeConfirm: defineChannel(
    'theme:confirm',
    z.object({ previewId: z.string().uuid() }),
    z.object({ confirmed: z.boolean(), settings: settingsSchema }),
  ),
  themeCancel: defineChannel('theme:cancel', z.object({ previewId: z.string().uuid() }), z.object({ cancelled: z.boolean() })),
  themeRemove: defineChannel('theme:remove', z.object({ id: themeIdSchema }), z.object({ removed: z.boolean(), settings: settingsSchema })),
  themeReset: defineChannel('theme:reset', z.object({}), z.object({ settings: settingsSchema })),
} as const;
