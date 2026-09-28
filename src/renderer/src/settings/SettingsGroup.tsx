import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';

import './settings.css';

export interface SettingsGroupProps {
  readonly heading: string;
  readonly hint?: string | undefined;
  readonly testId?: string | undefined;
  /** Two or more `Field` rows, directly. */
  readonly children: ReactNode;
}

const DEV = (import.meta.env as ImportMetaEnv | undefined)?.DEV === true;

// A settings subsection (Pass C spec, Group; #1296): a region named by its
// heading, holding Field rows at the pane's own indent. It draws no border of
// its own; its rows keep their hairlines. Groups do not nest.
export function SettingsGroup({ heading, hint, testId, children }: SettingsGroupProps): ReactElement {
  const headingId = useId();
  const hintId = useId();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!DEV || ref.current === null) return;
    for (const problem of settingsGroupProblems(ref.current)) console.error(`SettingsGroup "${heading}" ${problem}.`);
  });
  return (
    <section
      ref={ref}
      className="ovl-settings__group"
      aria-labelledby={headingId}
      aria-describedby={hint === undefined ? undefined : hintId}
      data-testid={testId}
    >
      <h3 id={headingId} className="ovl-settings__groupHeading">
        {heading}
      </h3>
      {hint === undefined ? null : (
        <p id={hintId} className="prose-note ovl-settings__groupHint">
          {hint}
        </p>
      )}
      {children}
    </section>
  );
}

/** What breaks the group rules: at least two Field rows directly inside, no
 *  group inside another, no Field inside another. Asserted in dev builds. */
export function settingsGroupProblems(group: Element): readonly string[] {
  const problems: string[] = [];
  const fields = Array.from(group.children).filter((child) => child.classList.contains('ovl-settings__field')).length;
  if (fields < 2) problems.push(`needs at least 2 Field rows directly inside it, found ${String(fields)}`);
  if (group.parentElement?.closest('.ovl-settings__group') != null) problems.push('is nested in another SettingsGroup');
  if (group.querySelector('.ovl-settings__group') !== null) problems.push('contains another SettingsGroup');
  if (group.querySelector('.ovl-settings__field .ovl-settings__field') !== null) problems.push('contains a Field nested in another Field');
  return problems;
}
