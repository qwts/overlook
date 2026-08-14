import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_ORIENTATION,
  DEFAULT_VIEW_INTENT,
  ZOOM_MAX,
  ZOOM_MIN,
  fillZoom,
  fitSize,
  orientedSize,
  panBy,
  resizeTransform,
  rotateOrientation,
  flipVerticalOrientation,
  transformToViewIntent,
  viewIntentToTransform,
  zoomAround,
} from '../../src/renderer/src/lightbox/geometry.js';

/** `LightboxViewport.KEYBOARD_ZOOM_STEP` — what the +/- controls request. */
const KEYBOARD_ZOOM_STEP = 1.25;

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${String(actual)} should be close to ${String(expected)}`);
}

/** The cover scale is a division, so the product can land an ULP under. */
function assertCovers(rendered: number, viewport: number, message: string): void {
  assert.ok(rendered >= viewport - 1e-6, `${message} (${String(rendered)} of ${String(viewport)})`);
}

describe('lightbox transform geometry (#307)', () => {
  test('fit keeps landscape and portrait images wholly visible', () => {
    const landscape = fitSize({ width: 600, height: 400 }, { width: 400, height: 400 });
    assert.equal(landscape.width, 400);
    assertClose(landscape.height, 400 / 1.5);
    const portrait = fitSize({ width: 400, height: 600 }, { width: 400, height: 400 });
    assertClose(portrait.width, 400 / 1.5);
    assert.equal(portrait.height, 400);
  });

  test('pan clamps both axes without exposing space beyond an edge', () => {
    const fitted = { width: 400, height: 400 / 1.5 };
    assert.deepEqual(panBy({ zoom: 2, x: 0, y: 0 }, { x: 999, y: -999 }, fitted, { width: 400, height: 400 }), {
      zoom: 2,
      x: 200,
      y: -(400 / 1.5 - 200),
    });
  });

  test('zoom preserves the focal image point and stays within 0.25x-8x', () => {
    const fitted = { width: 400, height: 400 / 1.5 };
    const viewport = { width: 400, height: 400 };
    assert.deepEqual(zoomAround({ zoom: 1, x: 0, y: 0 }, 2, { x: 100, y: 200 }, fitted, viewport), {
      zoom: 2,
      x: 100,
      y: 0,
    });
    assert.equal(zoomAround({ zoom: 1, x: 0, y: 0 }, 99, { x: 200, y: 200 }, fitted, viewport).zoom, ZOOM_MAX);
    assert.equal(zoomAround({ zoom: 1, x: 0, y: 0 }, 0, { x: 200, y: 200 }, fitted, viewport).zoom, ZOOM_MIN);
  });

  test('resize reclamps custom transforms and recomputes active Fill', () => {
    assert.deepEqual(resizeTransform({ zoom: 2, x: 500, y: 500 }, 'custom', { width: 300, height: 200 }, { width: 400, height: 300 }), {
      zoom: 2,
      x: 100,
      y: 50,
    });
    const resizedFill = resizeTransform({ zoom: 1, x: 90, y: -999 }, 'fill', { width: 700, height: 525 }, { width: 1600, height: 900 });
    assertClose(resizedFill.zoom, 1600 / 700);
    assertClose(resizedFill.x, 0);
    assertClose(resizedFill.y, -(525 * (1600 / 700) - 900) / 2);
  });
});

describe('lightbox Fill covers the viewport (#968)', () => {
  test('Fill covers the viewport on both axes for every aspect ratio (#371, #501, #898, #968)', () => {
    const widescreen = { width: 1600, height: 900 };
    assertClose(fillZoom({ width: 700, height: 525 }, widescreen), 1600 / 700);
    assertClose(fillZoom({ width: 525, height: 700 }, widescreen), 1600 / 525);
    assertClose(fillZoom({ width: 1600, height: 700 }, widescreen), 900 / 700);
    assertClose(fillZoom({ width: 700, height: 1600 }, widescreen), 1600 / (700 * (900 / 1600)));
    assertClose(fillZoom({ width: 2100, height: 700 }, widescreen), 1.6875);
    assert.equal(fillZoom({ width: 1600, height: 900 }, widescreen), 1);
    assert.equal(fillZoom({ width: 320, height: 180 }, widescreen), 5);
    assert.equal(fillZoom({ width: 0, height: 0 }, widescreen), 1);
  });

  test('Fill matches a square image to the larger viewport axis, never the smaller (#898, #968)', () => {
    // `min()` here is `contain`: it leaves bars on the long axis. A square has no
    // long side to fit by accident, so it is the canonical regression case.
    assertClose(fillZoom({ width: 1000, height: 1000 }, { width: 700, height: 1600 }), 1600 / 700);
    assertClose(fillZoom({ width: 320, height: 320 }, { width: 1600, height: 900 }), 1600 / 320);
    assert.equal(fillZoom({ width: 800, height: 800 }, { width: 800, height: 800 }), 1);
    assert.ok(fillZoom({ width: 801, height: 800 }, { width: 800, height: 800 }) > 1);
  });

  test('Fill never leaves a bar on any side, for any image against any viewport (#968)', () => {
    const images = [
      { width: 1, height: 1 },
      { width: 800, height: 800 },
      { width: 801, height: 800 },
      { width: 4032, height: 4032 },
      { width: 1600, height: 900 },
      { width: 900, height: 1600 },
      { width: 6000, height: 4000 },
      { width: 4000, height: 6000 },
      { width: 320, height: 180 },
      { width: 12000, height: 1200 },
      { width: 1200, height: 12000 },
    ];
    const viewports = [
      { width: 1600, height: 900 },
      { width: 900, height: 1600 },
      { width: 800, height: 800 },
      { width: 3840, height: 2160 },
      { width: 420, height: 380 },
      { width: 1024, height: 768 },
      { width: 300, height: 1400 },
    ];

    for (const image of images) {
      for (const viewport of viewports) {
        const fitted = fitSize(image, viewport);
        const zoom = viewIntentToTransform({ ...DEFAULT_VIEW_INTENT, mode: 'fill' }, image, viewport).zoom;
        const label = `${String(image.width)}x${String(image.height)} in ${String(viewport.width)}x${String(viewport.height)}`;
        assertCovers(fitted.width * zoom, viewport.width, `${label} leaves a vertical bar`);
        assertCovers(fitted.height * zoom, viewport.height, `${label} leaves a horizontal bar`);
      }
    }
  });

  test('zoom in from a Fill that needed more than 8x never shrinks the image (#968)', () => {
    // The ceiling is per-geometry, so a manual zoom request cannot fall back to
    // a flat 8x here — that would make "Zoom in" shrink a covered panorama to a
    // sixth of the viewport height and hand back the bars Fill just removed.
    const image = { width: 12000, height: 1200 };
    const viewport = { width: 700, height: 1600 };
    const fitted = fitSize(image, viewport);
    const fill = fillZoom(image, viewport);
    const zoomedIn = zoomAround({ zoom: fill, x: 0, y: 0 }, fill * KEYBOARD_ZOOM_STEP, { x: 350, y: 800 }, fitted, viewport);

    assert.ok(fill > ZOOM_MAX, 'this photo needs more than the manual ceiling to cover');
    assert.ok(zoomedIn.zoom >= fill, `zoom in dropped to ${String(zoomedIn.zoom)} from ${String(fill)}`);
    assertCovers(fitted.height * zoomedIn.zoom, viewport.height, 'zoom in re-exposed a horizontal bar');
  });

  test('resize reclamps custom transforms and recomputes active Fill', () => {
    assert.deepEqual(resizeTransform({ zoom: 2, x: 500, y: 500 }, 'custom', { width: 300, height: 200 }, { width: 400, height: 300 }), {
      zoom: 2,
      x: 100,
      y: 50,
    });
    const resizedFill = resizeTransform({ zoom: 1, x: 90, y: -999 }, 'fill', { width: 700, height: 525 }, { width: 1600, height: 900 });
    assertClose(resizedFill.zoom, 1600 / 700);
    assertClose(resizedFill.x, 0);
    assertClose(resizedFill.y, -(525 * (1600 / 700) - 900) / 2);
  });
});

describe('lightbox navigation view intent (#501)', () => {
  test('view intent preserves zoom and normalized focal position across aspect ratios (#501)', () => {
    const viewport = { width: 800, height: 600 };
    const landscapeFit = fitSize({ width: 1600, height: 900 }, viewport);
    const intent = transformToViewIntent({ zoom: 2, x: 300, y: -150 }, 'custom', landscapeFit, viewport);

    assert.deepEqual(intent, { mode: 'custom', zoom: 2, panX: 0.75, panY: -1 });
    assert.deepEqual(viewIntentToTransform(intent, { width: 900, height: 1600 }, viewport), {
      zoom: 2,
      x: 0,
      y: -300,
    });
    assert.deepEqual(viewIntentToTransform(DEFAULT_VIEW_INTENT, { width: 900, height: 1600 }, viewport), {
      zoom: 1,
      x: 0,
      y: 0,
    });
  });

  test('Fill intent recomputes edge-to-edge scale with one overflow axis per photo (#501)', () => {
    const viewport = { width: 800, height: 600 };
    const intent = { ...DEFAULT_VIEW_INTENT, mode: 'fill' as const, panX: 1, panY: -1 };
    const portrait = viewIntentToTransform(intent, { width: 900, height: 1600 }, viewport);
    const landscape = viewIntentToTransform(intent, { width: 1600, height: 900 }, viewport);

    assertClose(portrait.zoom, 800 / 337.5);
    assert.equal(portrait.x, 0, 'portrait fills width and cannot scroll horizontally');
    assert.ok(portrait.y < 0, 'portrait scrolls vertically');
    assertClose(landscape.zoom, 600 / 450);
    assert.ok(landscape.x > 0, 'landscape scrolls horizontally');
    assertClose(landscape.y, 0);
  });

  test('Fill intent matches a square image to the taller viewport axis (#898, #968)', () => {
    const square = viewIntentToTransform(
      { ...DEFAULT_VIEW_INTENT, mode: 'fill' },
      { width: 1000, height: 1000 },
      { width: 700, height: 1600 },
    );

    // Fitted 700x700, covered at 1600/700: the height fills top to bottom and
    // the sides overflow, so this one scrolls horizontally.
    assertClose(square.zoom, 1600 / 700);
    assert.equal(square.x, 0, 'centred until panned');
    assert.equal(square.y, 0, 'the vertical axis is exactly filled');
  });

  test('Fill exceeds the manual zoom ceiling when covering demands it (#968)', () => {
    const panorama = viewIntentToTransform(
      { ...DEFAULT_VIEW_INTENT, mode: 'fill' },
      { width: 12000, height: 1200 },
      { width: 700, height: 1600 },
    );

    assert.ok(panorama.zoom > ZOOM_MAX, `${String(panorama.zoom)} should clear the ${String(ZOOM_MAX)}x manual ceiling`);
    assertClose(panorama.zoom, 1600 / (1200 * (700 / 12000)));
  });
});

describe('lightbox orientation geometry (#307)', () => {
  test('quarter turns swap fit axes and normalize after a complete rotation', () => {
    const clockwise = rotateOrientation(DEFAULT_ORIENTATION, 1);
    assert.deepEqual(clockwise, { quarterTurns: 1, flipped: false });
    assert.deepEqual(orientedSize({ width: 700, height: 525 }, clockwise), { width: 525, height: 700 });

    const completeTurn = [1, 2, 3, 4].reduce((orientation) => rotateOrientation(orientation, 1), DEFAULT_ORIENTATION);
    assert.deepEqual(completeTurn, DEFAULT_ORIENTATION);
  });

  test('rotate direction stays visual after a horizontal flip', () => {
    const flipped = { ...DEFAULT_ORIENTATION, flipped: true };

    assert.deepEqual(rotateOrientation(flipped, 1), { quarterTurns: 3, flipped: true });
    assert.deepEqual(rotateOrientation(flipped, -1), { quarterTurns: 1, flipped: true });
  });

  test('vertical flip composes as a half-turn plus horizontal reflection (#510)', () => {
    assert.deepEqual(flipVerticalOrientation(DEFAULT_ORIENTATION), { quarterTurns: 2, flipped: true });
    assert.deepEqual(flipVerticalOrientation(flipVerticalOrientation(DEFAULT_ORIENTATION)), DEFAULT_ORIENTATION);
    assert.deepEqual(flipVerticalOrientation({ quarterTurns: 1, flipped: true }), { quarterTurns: 3, flipped: false });
  });
});
