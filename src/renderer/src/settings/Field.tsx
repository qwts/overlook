import { useId, useMemo, type ReactElement, type ReactNode, type SelectHTMLAttributes } from 'react';

import { FieldNameContext, useFieldNameProps, type FieldName } from '../components/field-name';

import './settings.css';

/** `auto`: the control sits beside the label and wraps below it only when
 *  the label would drop under 220px. `stacked`: the control spans the row
 *  under the label, for compound controls (Pass C spec, #1295). */
export type FieldLayout = 'auto' | 'stacked';

export interface FieldProps {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly layout?: FieldLayout;
  readonly testId?: string;
  readonly children: ReactNode;
}

// The settings panes' row primitive per the design's Field: label (+ muted
// hint) at the start, control at the end, hairline below.
//
// An auto row's control takes its name and description from the row's label
// and hint (FieldNameContext), so it carries no wrapper group and no second
// copy of the label. A stacked row holds several controls that name
// themselves, so it stays a group named by the label.
export function Field({ label, hint, layout = 'auto', testId, children }: FieldProps): ReactElement {
  const labelId = useId();
  const hintId = useId();
  const describedBy = hint === undefined ? undefined : hintId;
  const name = useMemo<FieldName>(() => ({ labelId, hintId: describedBy }), [labelId, describedBy]);
  return (
    <div className={`ovl-settings__field ovl-settings__field--${layout}`} data-testid={testId}>
      <div className="ovl-settings__fieldText">
        <div id={labelId} className="ovl-settings__fieldLabel">
          {label}
        </div>
        {hint === undefined ? null : (
          <div id={hintId} className="ovl-settings__fieldHint">
            {hint}
          </div>
        )}
      </div>
      {layout === 'stacked' ? (
        <div className="ovl-settings__fieldControl" role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
          {children}
        </div>
      ) : (
        <div className="ovl-settings__fieldControl">
          <FieldNameContext.Provider value={name}>{children}</FieldNameContext.Provider>
        </div>
      )}
    </div>
  );
}

/** The settings select, named by its row when it sits in an auto `Field`. */
export function FieldSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): ReactElement {
  const names = useFieldNameProps(rest['aria-label']);
  return <select className={['ovl-settings__select', className].filter(Boolean).join(' ')} {...names} {...rest} />;
}
