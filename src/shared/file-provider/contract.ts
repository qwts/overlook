import { z } from 'zod';

export const FILE_PROVIDER_CONSENT_VERSION = 1 as const;

export const fileProviderScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library') }),
  z.object({
    kind: z.literal('albums'),
    albumIds: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
]);

export const fileProviderConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  consentVersion: z.literal(FILE_PROVIDER_CONSENT_VERSION),
  scope: fileProviderScopeSchema,
});

export const disabledFileProviderConfig: FileProviderConfig = {
  version: 1,
  enabled: false,
  consentVersion: FILE_PROVIDER_CONSENT_VERSION,
  scope: { kind: 'library' },
};

export interface FileProviderItem {
  readonly id: string;
  readonly parentId: string;
  readonly name: string;
  readonly kind: 'folder' | 'file';
  readonly size: number;
  readonly contentType: string;
  readonly modifiedAt: string;
  /** Finder must request bytes before opening an offloaded original. */
  readonly dataless: boolean;
  readonly readOnly: true;
}

export type FileProviderScope = z.output<typeof fileProviderScopeSchema>;
export type FileProviderConfig = z.output<typeof fileProviderConfigSchema>;
