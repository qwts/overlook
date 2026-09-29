import type { Page, TestInfo } from '@playwright/test';

// Diagnostic probe for a keyboard shortcut that goes missing only on Linux CI
// (#1279). It observes; it never retries the key or changes app state, so a
// lost shortcut still fails the test. On failure the report says whether the
// keydown reached the window, which element had focus, whether the command
// dispatcher handled it (it calls preventDefault on a handled command), and
// when the Lightbox, Inspector and any dialog appeared or went away.
//
// The in-page half is a string: the E2E tsconfig has no DOM lib.
const ARM = `((probeKey) => {
  const lines = [];
  window.__overlookShortcutProbe = lines;
  const started = performance.now();
  const log = (line) => {
    lines.push(String(Math.round(performance.now() - started)).padStart(6) + 'ms ' + line);
    if (lines.length > 200) lines.shift();
  };
  const describe = (node) => {
    if (!(node instanceof Element)) return String(node);
    const label = node.getAttribute('aria-label');
    const classes = typeof node.className === 'string' && node.className !== '' ? '.' + node.className.split(' ').join('.') : '';
    return node.tagName.toLowerCase() + classes + (label === null ? '' : '[' + label + ']');
  };
  const surfaces = () =>
    'lightbox=' + (document.querySelector('[data-testid="lightbox"]') !== null) +
    ' inspector=' + (document.querySelector('aside[aria-label="Inspector"]') !== null) +
    ' dialogs=' + document.querySelectorAll('[role="dialog"]').length;
  let last = '';
  const observe = () => {
    const next = surfaces();
    if (next === last) return;
    last = next;
    log(next);
  };
  new MutationObserver(observe).observe(document.body, { childList: true, subtree: true });
  observe();
  window.addEventListener('keydown', (event) => {
    if (event.key !== probeKey) return;
    log('keydown capture target=' + describe(event.target) + ' active=' + describe(document.activeElement) +
      ' hasFocus=' + document.hasFocus() + ' visibility=' + document.visibilityState + ' ' + surfaces());
    setTimeout(() => log('keydown settled handled=' + event.defaultPrevented + ' ' + surfaces()));
  }, { capture: true });
  window.addEventListener('keydown', (event) => {
    if (event.key === probeKey) log('keydown bubbled to window');
  });
  window.addEventListener('keyup', (event) => {
    if (event.key === probeKey) log('keyup');
  });
})`;

export async function armShortcutProbe(page: Page, key: string): Promise<void> {
  await page.evaluate(`${ARM}(${JSON.stringify(key)})`);
}

/** Attach and print the probe's log; never throws, so it cannot mask the failure. */
export async function reportShortcutProbe(page: Page, testInfo: TestInfo): Promise<void> {
  let report: string;
  try {
    report = await page.evaluate<string>(`(window.__overlookShortcutProbe ?? ['probe was not armed']).join('\\n')`);
  } catch (error) {
    report = `probe unreadable: ${String(error)}`;
  }
  console.log(`[shortcut-probe #1279]\n${report}`);
  await testInfo.attach('shortcut-probe', { body: report, contentType: 'text/plain' }).catch(() => undefined);
}
