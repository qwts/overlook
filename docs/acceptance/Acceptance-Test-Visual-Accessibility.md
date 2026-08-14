# Visual Accessibility Acceptance

Manual companion to issue #401. Automation proves the renderer contract with
`tests/e2e/visual-accessibility.spec.ts` and `npm run lint:contrast`; this pass
checks the operating-system preferences and subjective readability that a
hidden Electron harness cannot reproduce.

## Reduced motion

1. Launch a packaged macOS or Windows build with reduced motion disabled.
2. Open Settings and Lightbox, switch libraries, and start a backup long enough
   to show a syncing indicator. Confirm the normal short fades and status
   rotation are visible.
3. Enable the OS reduced-motion preference without restarting Overlook.
4. Repeat the same actions. Confirm dialogs and Lightbox chrome change
   effectively immediately, status/progress glyphs remain visible but do not
   rotate continuously, and no skeleton or progress animation plays.
5. Open an animated GIF/WebP. Confirm its static poster remains until **Play
   animation** is explicitly activated.

## Contrast

1. Run `npm run lint:contrast`. Confirm every declared text/surface,
   text/accent, status/surface, and focus pair passes its 4.5:1 or 3:1 floor.
2. Review shell, grid/list, dialogs, Settings, status badges, destructive
   controls, and focus rings in dark and every shipped first-party theme.
3. Place both bright and dark photos behind tile overlays and Lightbox chrome.
   Confirm protective scrims keep labels legible. This remains manual because
   user-photo luminance is not a build-time token.

## 200% text and application zoom

1. Set the Electron/application zoom to 200% at the default 1280×800 window.
2. Tab through the wrapped toolbar. Confirm Search, Filters, view selection,
   Zoom, Back up, Transfer & Sync, and Import are reachable with no horizontal
   document scrolling.
3. Scroll the Sidebar and open Settings. Confirm every tab and the Close button
   remain reachable; scroll each pane through its final control.
4. Open a photo. Confirm Back, Close, navigation, orientation, and zoom controls
   remain inside the viewport and the photo can still be panned when enlarged.
5. Launch a fresh profile. Confirm the recovery card scrolls vertically and its
   **Start a new library** and **Discover backups** actions remain reachable.
6. Repeat at the minimum supported window size. Confirm controls wrap or scroll
   within their owning region; no label overlaps another control.

## High contrast and forced colors

High contrast is an operating-system accessibility layer over the selected
Dark, Light, or System appearance; it is not a separate persisted appearance.
It always takes precedence over first-party and user-theme colors.

1. On macOS, launch a packaged build with **Increase contrast** disabled. Open
   Settings, Grid/List, Lightbox, dialogs, destructive confirmations, and
   protected-photo surfaces in Dark and Light.
2. Enable **Increase contrast** without restarting. Confirm borders, focus and
   selected rings, text hierarchy, status colors, scrims, and photo chrome all
   strengthen immediately while the selected base appearance remains stable.
3. Disable the preference and confirm the standard palette returns live.
4. On Windows, repeat with a High Contrast theme. Confirm Overlook uses the
   chosen system Canvas, CanvasText, Highlight, HighlightText, ButtonBorder,
   GrayText, and LinkText colors. Controls, selection, focus, disabled states,
   destructive actions, and photo-overlay controls remain distinguishable.
5. Change the Windows High Contrast theme while Overlook is open. Confirm the
   system palette updates without relaunch and that no app-wide
   `forced-color-adjust: none` opt-out defeats the user's colors.
6. Repeat with any installed user theme. Confirm the OS accessibility palette
   remains authoritative and Reset Appearance remains reachable.
