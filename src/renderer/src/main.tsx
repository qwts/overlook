import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/index.css';
import { App } from './App';
import { IntlHost } from './i18n/IntlHost';
import { installAppearanceObserver } from './theme/appearance';

installAppearanceObserver({
  root: document.documentElement,
  media: window.matchMedia('(prefers-color-scheme: dark)'),
  contrastMedia: window.matchMedia('(prefers-contrast: more)'),
  settings: window.overlook.settings,
});

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Renderer root element #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <IntlHost>
      <App />
    </IntlHost>
  </StrictMode>,
);
