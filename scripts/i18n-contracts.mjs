// FormatJS's compiled ICU AST is the source of argument contracts, including
// placeholders nested in select/plural branches and rich-text tags.
const AST_TYPE = {
  literal: 0,
  argument: 1,
  number: 2,
  date: 3,
  time: 4,
  select: 5,
  plural: 6,
  pound: 7,
  tag: 8,
};
const VALUE_TYPES = new Map([
  [AST_TYPE.argument, 'MessageValue'],
  [AST_TYPE.number, 'number'],
  [AST_TYPE.date, 'Date | number'],
  [AST_TYPE.time, 'Date | number'],
  [AST_TYPE.select, 'string'],
  [AST_TYPE.plural, 'number'],
  [AST_TYPE.tag, 'MessageTag'],
]);

export function messageArguments(elements) {
  const args = new Map();
  function visit(nodes) {
    for (const node of nodes) {
      const type = VALUE_TYPES.get(node.type);
      if (type !== undefined) {
        const previous = args.get(node.value);
        if (previous === undefined || previous === type || previous === 'MessageValue') {
          args.set(node.value, type);
        } else if (type === 'MessageValue') {
          // A plain placeholder also used as a number/date retains that constraint.
          if (previous === 'MessageTag') throw new Error(`ICU tag/value collision: ${node.value}`);
        } else if ([previous, type].every((value) => value === 'number' || value === 'Date | number')) {
          args.set(node.value, 'number');
        } else {
          throw new Error(`Incompatible ICU argument types for ${node.value}: ${previous}, ${type}`);
        }
        if (previous === 'MessageValue' && type === 'MessageTag') throw new Error(`ICU tag/value collision: ${node.value}`);
      } else if (node.type !== AST_TYPE.literal && node.type !== AST_TYPE.pound) {
        throw new Error(`Unsupported ICU AST node: ${node.type}`);
      }
      if (node.options !== undefined) {
        for (const option of Object.values(node.options)) visit(option.value);
      }
      if (node.children !== undefined) visit(node.children);
    }
  }
  visit(elements);
  return Object.fromEntries([...args].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function renderMessageContracts(ast) {
  const entries = Object.keys(ast)
    .sort()
    .flatMap((id) => {
      const args = Object.entries(messageArguments(ast[id]));
      if (args.length === 0) return [];
      const fields = args.map(([name, type]) => `${JSON.stringify(name)}: ${type}`).join('; ');
      return [`  ${JSON.stringify(id)}: { ${fields} };`];
    });
  return `
interface InterpolatedMessageArguments {
${entries.join('\n')}
}

export type SourceMessageArguments = {
  [K in keyof typeof en]: K extends keyof InterpolatedMessageArguments
    ? InterpolatedMessageArguments[K]
    : Record<never, never>;
};
`;
}
