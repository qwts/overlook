import { createContext, useContext } from 'react';

/** The ids of an auto settings row's visible label and hint (#1295). A
 *  control inside the row takes its accessible name and description from
 *  them, so the row's text is the one source for both. */
export interface FieldName {
  readonly labelId: string;
  readonly hintId: string | undefined;
}

export const FieldNameContext = createContext<FieldName | null>(null);

export interface FieldNameProps {
  readonly 'aria-labelledby'?: string | undefined;
  readonly 'aria-describedby'?: string | undefined;
}

/** A control named by its row: `aria-labelledby` the label and
 *  `aria-describedby` the hint. Nothing when the control names itself
 *  (`ownName`) or sits outside an auto row. */
export function useFieldNameProps(ownName: string | undefined): FieldNameProps {
  const field = useContext(FieldNameContext);
  if (field === null || ownName !== undefined) return {};
  return { 'aria-labelledby': field.labelId, 'aria-describedby': field.hintId };
}

/** A control that keeps its own name, such as a button: the row's label and
 *  hint as its description, so "Change…" is still read as the App password
 *  row's. Undefined outside an auto row. */
export function useFieldDescription(): string | undefined {
  const field = useContext(FieldNameContext);
  if (field === null) return undefined;
  return field.hintId === undefined ? field.labelId : `${field.labelId} ${field.hintId}`;
}
