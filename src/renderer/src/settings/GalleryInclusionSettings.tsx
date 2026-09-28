import { useEffect, useState, type ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Switch } from '../components/Switch';
import { Field, FieldSelect } from './Field';
import { SettingsGroup } from './SettingsGroup';
import { DEFAULT_GALLERY_POLICY, MINIMUM_MEGAPIXEL_OPTIONS, type GalleryPolicy } from '../../../shared/library/gallery-policy.js';

// All Photos inclusion rules (#512, ADR-0030 §4). These are library data,
// not profile settings: they are read from and written to the encrypted
// library through their own channel, and main re-announces the library so
// the open gallery and sidebar counts follow immediately.

export const galleryInclusionMessages = defineMessages({
  heading: { id: 'settings.general.allPhotos', defaultMessage: 'All Photos' },
  hint: {
    id: 'settings.general.allPhotos.hint',
    defaultMessage:
      'These rules change only what All Photos shows. Albums, search, backup, export, and the RAW and Unavailable sources are never affected.',
  },
  showUnavailable: { id: 'settings.general.allPhotos.showUnavailable', defaultMessage: 'Show unavailable items' },
  minimumSize: { id: 'settings.general.allPhotos.minimumSize', defaultMessage: 'Minimum size' },
  minimumSizeHint: {
    id: 'settings.general.allPhotos.minimumSize.hint',
    defaultMessage: 'Items whose dimensions are unknown are always shown, whatever the minimum.',
  },
  none: { id: 'settings.general.allPhotos.minimumSize.none', defaultMessage: 'None — show every size' },
  megapixels: { id: 'settings.general.allPhotos.minimumSize.megapixels', defaultMessage: '{count} MP and larger' },
});

export function GalleryInclusionSettings(): ReactElement {
  const intl = useIntl();
  const [policy, setPolicy] = useState<GalleryPolicy | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.overlook.library.galleryPolicy().then(({ policy: loaded }) => {
      if (!cancelled) setPolicy(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const current = policy ?? DEFAULT_GALLERY_POLICY;
  const update = (patch: Partial<GalleryPolicy>): void => {
    const next = { ...current, ...patch };
    setPolicy(next);
    void window.overlook.library.setGalleryPolicy({ policy: next }).then(({ policy: stored }) => {
      setPolicy(stored);
    });
  };
  const disabled = policy === null;
  return (
    <SettingsGroup
      heading={intl.formatMessage(galleryInclusionMessages.heading)}
      hint={intl.formatMessage(galleryInclusionMessages.hint)}
      testId="gallery-inclusion"
    >
      <Field label={intl.formatMessage(galleryInclusionMessages.showUnavailable)}>
        <Switch
          checked={current.showUnavailable}
          disabled={disabled}
          onChange={(showUnavailable) => {
            update({ showUnavailable });
          }}
        />
      </Field>
      <Field
        label={intl.formatMessage(galleryInclusionMessages.minimumSize)}
        hint={intl.formatMessage(galleryInclusionMessages.minimumSizeHint)}
      >
        <FieldSelect
          disabled={disabled}
          value={current.minimumMegapixels === null ? '' : String(current.minimumMegapixels)}
          onChange={(event) => {
            update({ minimumMegapixels: event.target.value === '' ? null : Number(event.target.value) });
          }}
        >
          <option value="">{intl.formatMessage(galleryInclusionMessages.none)}</option>
          {MINIMUM_MEGAPIXEL_OPTIONS.map((megapixels) => (
            <option key={megapixels} value={String(megapixels)}>
              {intl.formatMessage(galleryInclusionMessages.megapixels, { count: megapixels })}
            </option>
          ))}
        </FieldSelect>
      </Field>
    </SettingsGroup>
  );
}
