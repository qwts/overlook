import type { ReactElement } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { Checkbox } from '../components/Checkbox.js';
import { Icon } from '../components/Icon.js';
import { useFormats } from '../i18n/use-formats.js';

export type PhotoKitState =
  | { readonly status: 'empty' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly reviewId: string;
      readonly authorization: 'authorized' | 'limited';
      readonly assets: readonly {
        readonly id: string;
        readonly fileName: string;
        readonly mediaType: 'image' | 'video';
        readonly width: number;
        readonly height: number;
        readonly createdAt: string | null;
      }[];
    }
  | { readonly status: 'error'; readonly reason: 'denied' | 'restricted' | 'unavailable' | 'cancelled' };

const messages = defineMessages({
  reviewTitle: { id: 'import.photoKit.reviewTitle', defaultMessage: 'Review Apple Photos items' },
  selected: { id: 'import.photoKit.selected', defaultMessage: '{selected} of {total} selected' },
  selectedLimited: {
    id: 'import.photoKit.selectedLimited',
    defaultMessage: '{selected} of {total} selected · Limited Photos access',
  },
  availableItems: { id: 'import.photoKit.availableItems', defaultMessage: 'Apple Photos items available to import' },
  asset: { id: 'import.photoKit.asset', defaultMessage: '{fileName} · {mediaType}{dimensions}' },
  reviewNote: {
    id: 'import.photoKit.reviewNote',
    defaultMessage: 'Only checked originals leave Apple Photos. Embedded metadata is preserved when supported.',
  },
  waiting: { id: 'import.photoKit.waiting', defaultMessage: 'Waiting for Apple Photos authorization…' },
  denied: { id: 'import.photoKit.denied', defaultMessage: 'Apple Photos access was denied' },
  restricted: { id: 'import.photoKit.restricted', defaultMessage: 'Apple Photos access is restricted on this Mac' },
  unavailable: { id: 'import.photoKit.unavailable', defaultMessage: 'Apple Photos import requires a signed macOS build' },
  cancelled: { id: 'import.photoKit.cancelled', defaultMessage: 'Apple Photos selection was cancelled' },
  reviewAction: { id: 'import.photoKit.reviewAction', defaultMessage: 'Review photos from Apple Photos' },
  tryAgain: { id: 'import.photoKit.tryAgain', defaultMessage: 'Try again' },
  requestHint: { id: 'import.photoKit.requestHint', defaultMessage: 'Requests read access in the foreground' },
});

export function PhotoKitImportSource({
  state,
  selection,
  onChoose,
  onToggle,
}: {
  readonly state: PhotoKitState;
  readonly selection: ReadonlySet<string>;
  readonly onChoose: () => void;
  readonly onToggle: (assetId: string, checked: boolean) => void;
}): ReactElement {
  const { formatCount } = useFormats();
  const intl = useIntl();
  if (state.status === 'ready') {
    return (
      <div className="ovl-import__photosReview">
        <div className="ovl-import__card" data-testid="photokit-review">
          <Icon name="image" size={16} color="var(--accent-cyan)" />
          <div className="ovl-import__cardText">
            <div className="ovl-import__cardTitle">{intl.formatMessage(messages.reviewTitle)}</div>
            <div className="ovl-import__cardMeta mono-data">
              {intl.formatMessage(state.authorization === 'limited' ? messages.selectedLimited : messages.selected, {
                selected: formatCount(selection.size),
                total: formatCount(state.assets.length),
              })}
            </div>
          </div>
        </div>
        <div className="ovl-import__photosList" aria-label={intl.formatMessage(messages.availableItems)}>
          {state.assets.map((asset) => (
            <Checkbox
              key={asset.id}
              checked={selection.has(asset.id)}
              label={intl.formatMessage(messages.asset, {
                fileName: asset.fileName,
                mediaType: asset.mediaType,
                dimensions: asset.width > 0 && asset.height > 0 ? ` · ${String(asset.width)}×${String(asset.height)}` : '',
              })}
              onChange={(checked) => onToggle(asset.id, checked)}
            />
          ))}
        </div>
        <div className="ovl-import__note mono-data">
          <Icon name="info" size={12} />
          {intl.formatMessage(messages.reviewNote)}
        </div>
      </div>
    );
  }
  if (state.status === 'loading') {
    return (
      <div className="ovl-import__card">
        <Icon name="image" size={16} />
        <div className="ovl-import__cardMeta mono-data">{intl.formatMessage(messages.waiting)}</div>
      </div>
    );
  }
  return (
    <button type="button" className="ovl-import__empty ovl-import__empty--action" onClick={onChoose}>
      <Icon name="image" size={20} color="var(--text-faint)" />
      <div className="ovl-import__emptyTitle">
        {state.status === 'error' ? intl.formatMessage(messages[state.reason]) : intl.formatMessage(messages.reviewAction)}
      </div>
      <div className="ovl-import__emptyHint">{intl.formatMessage(state.status === 'error' ? messages.tryAgain : messages.requestHint)}</div>
    </button>
  );
}
