import type { ReactElement } from 'react';

import { CopyableValue } from './CopyableValue';

import './feedback.css';

export interface MetadataRowProps {
  readonly label: string;
  readonly value: string;
  /** Machine data defaults to mono; prose rows opt out. */
  readonly mono?: boolean;
  /** Color override, e.g. var(--accent-green) for an encrypted backup. */
  readonly tone?: string;
  /** Adds the shared copy action when this row is a load-bearing value. */
  readonly copyLabel?: string;
}

// media/MetadataRow.jsx — 88px uppercase-mono label + truncating value.
export function MetadataRow({ label, value, mono = true, tone, copyLabel }: MetadataRowProps): ReactElement {
  return (
    <dl className="ovl-metadata-row">
      <dt className="ovl-metadata-row__label">{label}</dt>
      <dd
        className={`ovl-metadata-row__value${mono ? '' : ' ovl-metadata-row__value--sans'}${copyLabel === undefined ? '' : ' ovl-metadata-row__value--copyable'}`}
        style={tone === undefined ? undefined : { color: tone }}
      >
        {copyLabel === undefined ? value : <CopyableValue value={value} label={copyLabel} />}
      </dd>
    </dl>
  );
}
