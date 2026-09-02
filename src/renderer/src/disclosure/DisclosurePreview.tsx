import { useId, type ReactElement } from 'react';
import { useIntl } from 'react-intl';

import { Badge, type BadgeTone } from '../components/Badge';
import { Icon } from '../components/Icon';
import { Switch } from '../components/Switch';
import type { DisclosureClass, DisclosureDestination, DisclosureField } from '../../../shared/disclosure/policy.js';
import type { DisclosurePreview as DisclosurePreviewData } from '../../../shared/ipc/disclosure-channels.js';
import { classLabel, disclosureMessages, fieldLabel } from './disclosure-messages.js';

import './disclosure.css';

// The exact preview ADR-0032 §6 requires before a crossing (#509): which
// fields, which values, which destination, and what changes on decline. The
// data comes from main's plan; this component only renders it and collects
// the operation-scope intent (public destination, per-field widening) that
// main recompiles the plan from.

export interface DisclosurePreviewProps {
  readonly preview: DisclosurePreviewData | null;
  readonly destination: DisclosureDestination;
  readonly onDestinationChange: (destination: DisclosureDestination) => void;
  readonly widen: readonly DisclosureField[];
  readonly onWidenChange: (widen: readonly DisclosureField[]) => void;
  readonly disabled?: boolean | undefined;
}

const TONES: Readonly<Record<DisclosureClass | 'mixed', BadgeTone>> = { private: 'amber', shared: 'cyan', public: 'red', mixed: 'neutral' };

export function DisclosurePreview({
  preview,
  destination,
  onDestinationChange,
  widen,
  onWidenChange,
  disabled = false,
}: DisclosurePreviewProps): ReactElement {
  const intl = useIntl();
  const headingId = useId();
  const rows = preview?.fields.filter((field) => field.present > 0) ?? [];
  return (
    <section className="ovl-disclosure ovl-disclosure--preview" data-testid="disclosure-preview" aria-labelledby={headingId}>
      <div className="ovl-disclosure__head">
        <h4 id={headingId} className="ovl-disclosure__title">
          {intl.formatMessage(disclosureMessages.previewHeading)}
        </h4>
        <div className="ovl-disclosure__switch">
          <Switch
            checked={destination === 'public'}
            disabled={disabled}
            onChange={(next) => {
              onDestinationChange(next ? 'public' : 'shared');
            }}
            label={intl.formatMessage(disclosureMessages.previewDestination)}
          />
        </div>
        <p className="ovl-disclosure__hint">{intl.formatMessage(disclosureMessages.previewDestinationHint)}</p>
      </div>
      {preview === null ? (
        <p className="ovl-disclosure__hint" data-testid="disclosure-preview-loading">
          {intl.formatMessage(disclosureMessages.previewLoading)}
        </p>
      ) : rows.length === 0 ? (
        <p className="ovl-disclosure__hint" data-testid="disclosure-preview-empty">
          {intl.formatMessage(disclosureMessages.previewNothing)}
        </p>
      ) : (
        <ul className="ovl-disclosure__rows">
          {rows.map((row) => (
            <li
              key={row.field}
              className={`ovl-disclosure__row${row.disclosed === 0 ? ' ovl-disclosure__row--withheld' : ''}`}
              data-testid={`disclosure-row-${row.field}`}
              data-disclosed={row.disclosed}
            >
              <span className="ovl-disclosure__field">
                {fieldLabel(intl, row.field)}
                <Badge tone={TONES[row.class]}>{classLabel(intl, row.class)}</Badge>
              </span>
              <span className="ovl-disclosure__count mono-data">
                {row.disclosed === 0
                  ? intl.formatMessage(disclosureMessages.previewWithheld)
                  : intl.formatMessage(disclosureMessages.previewCrosses, { disclosed: row.disclosed, present: row.present })}
              </span>
              {row.sample !== null && row.disclosed > 0 ? <span className="ovl-disclosure__sample mono-data">{row.sample}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {preview !== null && preview.embedded.length > 0 ? (
        <p className="ovl-disclosure__hint" data-testid="disclosure-embedded">
          {intl.formatMessage(disclosureMessages.previewEmbedded, {
            fields: preview.embedded.map((field) => fieldLabel(intl, field)).join(', '),
          })}
        </p>
      ) : null}
      {preview !== null && preview.blocked.length > 0 ? (
        <div className="ovl-disclosure__blocked" role="alert" data-testid="disclosure-blocked">
          <Icon name="triangle-alert" size={12} />
          {intl.formatMessage(disclosureMessages.previewBlocked)}
        </div>
      ) : null}
      {preview === null
        ? null
        : [...new Set([...preview.blocked, ...widen])].map((field) => (
            <label key={field} className="ovl-disclosure__widen" data-testid={`disclosure-widen-${field}`}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={widen.includes(field)}
                onChange={(event) => {
                  onWidenChange(event.target.checked ? [...widen, field] : widen.filter((entry) => entry !== field));
                }}
              />
              {intl.formatMessage(disclosureMessages.previewWiden, { field: fieldLabel(intl, field) })}
            </label>
          ))}
      {preview !== null && preview.retainedSidecars > 0 ? (
        <p className="ovl-disclosure__hint" data-testid="disclosure-sidecars">
          {intl.formatMessage(disclosureMessages.previewSidecars, { count: preview.retainedSidecars })}
        </p>
      ) : null}
      <p className="ovl-disclosure__hint">{intl.formatMessage(disclosureMessages.previewDecline)}</p>
    </section>
  );
}
