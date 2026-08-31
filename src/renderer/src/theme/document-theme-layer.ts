import { UserThemeLayer } from './user-theme-layer';

export function documentThemeLayer(documentHost: Document): UserThemeLayer {
  return new UserThemeLayer({
    root: documentHost.documentElement,
    createSheet: () => new CSSStyleSheet(),
    adoptedSheets: () => documentHost.adoptedStyleSheets,
    adopt: (sheets) => {
      documentHost.adoptedStyleSheets = sheets as CSSStyleSheet[];
    },
  });
}
