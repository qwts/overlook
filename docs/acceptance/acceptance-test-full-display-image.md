# Acceptance Test: Full-Display Image

Issues: [#501](https://github.com/qwts/photos/issues/501),
[#513](https://github.com/qwts/photos/issues/513),
[#499](https://github.com/qwts/photos/issues/499),
[#449](https://github.com/qwts/photos/issues/449), and
[overlook#898](https://github.com/qwts/overlook/issues/898)

## Purpose

Verify that full view keeps the photo visually dominant, preserves a useful
zoom and focal position while navigating, and resets state at the correct
session boundaries. This script complements automated geometry, Storybook, and
Electron coverage, including the keyboard-pan contract from #449.

## Setup

1. Open a library containing adjacent landscape, portrait, square, and
   near-square photos, plus one unavailable or corrupt item.
2. Open the first photo in full view at the normal window size.
3. Repeat the matrix at the minimum supported window size and with Inspector
   both closed and docked.

## Image-first chrome

1. Click the displayed image once.
2. Confirm the top bar, navigation, transform controls, metadata strip, and
   Inspector chrome hide, leaving no distraction over the image.
3. Move the pointer or focus a control by keyboard. Confirm the chrome returns.
4. Double-click the image. Confirm Fill activates without the single-click
   gesture hiding the controls before the double-click completes.

## Transform-toolbar visual parity

Use `design/handoff/references/06-lightbox-default-contain.png` as the source
reference at its native 924×540 viewport. Confirm the orientation toolbar:

1. remains horizontally centered and sits 448px from the viewport top;
2. uses a 155×34px tokenized surface with the handoff shadow and 6px radius;
3. preserves four 28×28px controls, the separator, and an 11px gap before the
   separate zoom surface;
4. keeps the same geometry with Inspector undocked, then stacks without overlap
   at the 600px compact fixture and at 200% application zoom;
5. fades and wakes with the rest of the lightbox chrome, while hover, pressed,
   disabled, and keyboard-focus states remain visible.

## Transform persistence

1. Zoom above Fit and pan to a recognizable edge or subject.
2. Navigate Previous and Next across landscape and portrait photos.
3. Confirm the zoom scale persists and the same normalized focal region remains
   useful. The image must reclamp without blank space, NaN transforms, or a
   stale frame.
4. Double-click a portrait photo to activate Fill, then navigate with the arrow
   keys. Confirm every next photo inherits **Fill behavior**, not the prior
   photo's numeric zoom percentage:
   - a portrait fills edge to edge horizontally and scrolls only vertically;
   - a landscape fills edge to edge vertically and scrolls only horizontally.
5. Pan to an edge and navigate again. Confirm Fill recomputes for each aspect
   ratio while retaining a useful normalized focal direction. A photo close to
   the window's aspect ratio may need no scrolling; it must never require both
   axes.
6. Open the square and near-square photos in a square display area. Confirm
   they remain wholly visible without unnecessary scrolling. Resize the display
   so that Fill genuinely overflows one axis by more than one physical pixel,
   then confirm only that axis scrolls.
7. Dock and undock Inspector, then resize the window. Confirm the transform
   reclamps and every image continues to cover the required viewport axes.
8. Rotate or flip one photo, then navigate. Confirm orientation resets for the
   next photo while zoom/fill/pan persist.

## Reset and failure boundaries

1. Use **Fit image (0)**. Confirm zoom and pan reset immediately.
2. Zoom again, close full view to the gallery, and reopen any photo. Confirm a
   fresh Fit view with centered pan.
3. Switch libraries or lock and unlock the app, then reopen full view. Confirm
   no transform leaks from the prior session.
4. Navigate from a zoomed photo to an unavailable or corrupt item. Confirm the
   explicit unavailable state appears without blank-space artifacts and the
   transform resets safely before a compatible image is shown again.

## Accessibility and motion

1. At 200% application zoom, confirm every full-view control remains reachable
   and the image does not obscure focused controls.
2. Zoom until the image overflows both axes. Confirm all four Arrow keys pan in
   their expected directions and stop at the image bounds without exposing blank
   space.
3. Reset to Fit. Confirm Left/Right return to Previous/Next photo navigation.
   In Fill mode with one-axis overflow, confirm arrows pan on the overflowing
   axis while Left/Right still navigate when horizontal panning is unavailable.
4. With reduced motion enabled, repeat navigation and reset. Confirm no
   nonessential transform or chrome animation plays.
5. Confirm all visible controls have keyboard focus states and accessible names.

## Automated evidence

- `tests/lightbox/lightbox-geometry.test.ts`
- `src/renderer/src/lightbox/Lightbox.stories.tsx`
- `tests/e2e/lightbox.spec.ts`
- `design/handoff/references/06-lightbox-default-contain.png`
- Acceptance ledger entries `m06-lightbox-transform` and
  `m06-lightbox-fill-cover`

## Required gates

- `npm run ci`
- `npm run test:stories:ci`
- `npm run test:e2e`
