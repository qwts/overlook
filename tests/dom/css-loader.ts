import type { LoadHook, ResolveHook } from 'node:module';

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  // Renderer sources use Vite's extensionless relative imports. TypeScript
  // preserves those specifiers, but the emitted DOM-test modules are .js.
  if (specifier.startsWith('.') && !/\.[^/]+$/u.test(specifier)) return nextResolve(`${specifier}.js`, context);
  if (!specifier.endsWith('.css')) return nextResolve(specifier, context);
  if (context.parentURL === undefined) throw new Error(`CSS import has no parent: ${specifier}`);
  return { shortCircuit: true, url: new URL(specifier, context.parentURL).href };
};

export const load: LoadHook = async (url, context, nextLoad) => {
  if (!url.endsWith('.css')) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: 'export {};' };
};
