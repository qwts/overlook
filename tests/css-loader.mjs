/** Lets the unit coverage lane import renderer components that pull in CSS. */
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith('.css')) return nextResolve(specifier, context);
  return { shortCircuit: true, url: new URL(specifier, context.parentURL).href };
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.css')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: 'export {};' };
}
