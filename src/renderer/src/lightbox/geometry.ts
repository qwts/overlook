export interface LightboxSize {
  readonly width: number;
  readonly height: number;
}

export interface LightboxPoint {
  readonly x: number;
  readonly y: number;
}

export interface LightboxTransform extends LightboxPoint {
  readonly zoom: number;
}

export type LightboxZoomMode = 'fit' | 'fill' | 'custom';

export interface LightboxViewIntent {
  readonly mode: LightboxZoomMode;
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export interface LightboxOrientation {
  readonly quarterTurns: 0 | 1 | 2 | 3;
  readonly flipped: boolean;
}

/** A persisted crop (#493): normalized to the ORIENTED image. */
export interface LightboxCrop {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** clip-path inset fractions in the element's own (source) space. */
export interface LightboxClipInset {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const DEFAULT_ORIENTATION: LightboxOrientation = { quarterTurns: 0, flipped: false };
export const DEFAULT_VIEW_INTENT: LightboxViewIntent = { mode: 'fit', zoom: 1, panX: 0, panY: 0 };

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;

export function rotateOrientation(orientation: LightboxOrientation, delta: -1 | 1): LightboxOrientation {
  // A screen-horizontal reflection reverses handedness. Invert the stored
  // source-space turn so Rotate right/left stays visually right/left after a
  // flip instead of appearing to run backwards.
  const visualDelta = orientation.flipped ? -delta : delta;
  const quarterTurns = (orientation.quarterTurns + visualDelta + 4) % 4;
  return { ...orientation, quarterTurns: quarterTurns as LightboxOrientation['quarterTurns'] };
}

/** Reflect across the visual vertical axis while retaining the compact D4 representation. */
export function flipVerticalOrientation(orientation: LightboxOrientation): LightboxOrientation {
  return {
    quarterTurns: ((orientation.quarterTurns + 2) % 4) as LightboxOrientation['quarterTurns'],
    flipped: !orientation.flipped,
  };
}

export function orientedSize(size: LightboxSize, orientation: LightboxOrientation): LightboxSize {
  return orientation.quarterTurns % 2 === 0 ? size : { width: size.height, height: size.width };
}

/** The framed region's size: the oriented image, or the crop cut from it. */
export function croppedSize(oriented: LightboxSize, crop: LightboxCrop | null): LightboxSize {
  return crop === null ? oriented : { width: oriented.width * crop.width, height: oriented.height * crop.height };
}

/** Where the crop's center sits relative to the oriented image's center, as
 * fractions of the oriented size (0 = centered). */
export function cropCenterOffset(crop: LightboxCrop | null): LightboxPoint {
  return crop === null ? { x: 0, y: 0 } : { x: crop.left + crop.width / 2 - 0.5, y: crop.top + crop.height / 2 - 0.5 };
}

/** Maps a crop drawn in oriented space back to the element's source space.
 * The element renders as flipX(rotate(source)), so a visual point goes back
 * through the mirror first and then through the inverse (counterclockwise)
 * turns. clip-path is evaluated in that source space, before the transform. */
export function cropInSourceSpace(crop: LightboxCrop, orientation: LightboxOrientation): LightboxCrop {
  const corners: [number, number][] = [
    [crop.left, crop.top],
    [crop.left + crop.width, crop.top],
    [crop.left, crop.top + crop.height],
    [crop.left + crop.width, crop.top + crop.height],
  ];
  const mapped = corners.map(([u, v]) => {
    let x = orientation.flipped ? 1 - u : u;
    let y = v;
    for (let turn = 0; turn < orientation.quarterTurns; turn += 1) [x, y] = [y, 1 - x];
    return [x, y] as const;
  });
  const xs = mapped.map(([x]) => x);
  const ys = mapped.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export function cropClipInset(crop: LightboxCrop, orientation: LightboxOrientation): LightboxClipInset {
  const source = cropInSourceSpace(crop, orientation);
  return { top: source.top, right: 1 - (source.left + source.width), bottom: 1 - (source.top + source.height), left: source.left };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function fitSize(image: LightboxSize, viewport: LightboxSize): LightboxSize {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(1, viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

/**
 * `object-fit: cover` for a box already reduced by {@link fitSize}: the scale at
 * which the rendered image reaches or exceeds the viewport on *both* axes.
 * `max`, never `min` — `min` is `contain`, which leaves bars (#371, #501, #898,
 * #968). Never below 1, because `fitSize` never returns a box larger than the
 * viewport, so Fill only ever grows the image.
 */
function coverZoom(fitted: LightboxSize, viewport: LightboxSize): number {
  if (fitted.width <= 0 || fitted.height <= 0) return 1;
  return Math.max(viewport.width / fitted.width, viewport.height / fitted.height);
}

/**
 * The one ceiling every transform obeys: `ZOOM_MAX`, raised to the cover scale
 * for the rare photo that needs more (a 10:1 panorama in a portrait window
 * wants ~23x). Clamping Fill at 8x would put back the bars Fill exists to
 * remove; clamping only *some* paths at 8x is worse still, because zooming in
 * from such a Fill would then shrink the image back to 8x and re-expose them.
 * So the ceiling is a property of the geometry, not of the mode or the gesture.
 */
function maximumZoom(fitted: LightboxSize, viewport: LightboxSize): number {
  return Math.max(ZOOM_MAX, coverZoom(fitted, viewport));
}

export function fillZoom(image: LightboxSize, viewport: LightboxSize): number {
  return coverZoom(fitSize(image, viewport), viewport);
}

export function resizeTransform(
  transform: LightboxTransform,
  mode: LightboxZoomMode,
  image: LightboxSize,
  viewport: LightboxSize,
): LightboxTransform {
  const fitted = fitSize(image, viewport);
  const zoom = mode === 'fill' ? fillZoom(image, viewport) : transform.zoom;
  return clampTransform({ ...transform, zoom }, fitted, viewport);
}

export function clampTransform(transform: LightboxTransform, fitted: LightboxSize, viewport: LightboxSize): LightboxTransform {
  const zoom = clamp(transform.zoom, ZOOM_MIN, maximumZoom(fitted, viewport));
  const maximumX = Math.max(0, (fitted.width * zoom - viewport.width) / 2);
  const maximumY = Math.max(0, (fitted.height * zoom - viewport.height) / 2);
  return {
    zoom,
    x: clamp(transform.x, -maximumX, maximumX),
    y: clamp(transform.y, -maximumY, maximumY),
  };
}

export function viewIntentToTransform(intent: LightboxViewIntent, image: LightboxSize, viewport: LightboxSize): LightboxTransform {
  const fitted = fitSize(image, viewport);
  const zoom = intent.mode === 'fill' ? fillZoom(image, viewport) : intent.zoom;
  const maximumX = Math.max(0, (fitted.width * zoom - viewport.width) / 2);
  const maximumY = Math.max(0, (fitted.height * zoom - viewport.height) / 2);
  return clampTransform(
    {
      zoom,
      x: clamp(intent.panX, -1, 1) * maximumX,
      y: clamp(intent.panY, -1, 1) * maximumY,
    },
    fitted,
    viewport,
  );
}

export function transformToViewIntent(
  transform: LightboxTransform,
  mode: LightboxZoomMode,
  fitted: LightboxSize,
  viewport: LightboxSize,
): LightboxViewIntent {
  const clamped = clampTransform(transform, fitted, viewport);
  const maximumX = Math.max(0, (fitted.width * clamped.zoom - viewport.width) / 2);
  const maximumY = Math.max(0, (fitted.height * clamped.zoom - viewport.height) / 2);
  return {
    mode,
    zoom: clamped.zoom,
    panX: maximumX === 0 ? 0 : clamped.x / maximumX,
    panY: maximumY === 0 ? 0 : clamped.y / maximumY,
  };
}

export function panBy(transform: LightboxTransform, delta: LightboxPoint, fitted: LightboxSize, viewport: LightboxSize): LightboxTransform {
  return clampTransform({ zoom: transform.zoom, x: transform.x + delta.x, y: transform.y + delta.y }, fitted, viewport);
}

export function zoomAround(
  transform: LightboxTransform,
  requestedZoom: number,
  focal: LightboxPoint,
  fitted: LightboxSize,
  viewport: LightboxSize,
): LightboxTransform {
  const current = clampTransform(transform, fitted, viewport);
  const zoom = clamp(requestedZoom, ZOOM_MIN, maximumZoom(fitted, viewport));
  const focalX = focal.x - viewport.width / 2;
  const focalY = focal.y - viewport.height / 2;
  const imageX = (focalX - current.x) / current.zoom;
  const imageY = (focalY - current.y) / current.zoom;
  return clampTransform(
    {
      zoom,
      x: focalX - imageX * zoom,
      y: focalY - imageY * zoom,
    },
    fitted,
    viewport,
  );
}
