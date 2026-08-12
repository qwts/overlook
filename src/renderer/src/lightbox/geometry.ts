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

export function fillZoom(image: LightboxSize, viewport: LightboxSize): number {
  const fitted = fitSize(image, viewport);
  if (fitted.width <= 0 || fitted.height <= 0) return 1;
  if (image.width === image.height) return 1;
  const zoom = image.height > image.width ? viewport.width / fitted.width : viewport.height / fitted.height;
  const growthX = Math.max(0, fitted.width * (zoom - 1));
  const growthY = Math.max(0, fitted.height * (zoom - 1));
  if (growthX <= 1 && growthY <= 1) return 1;
  return clamp(zoom, ZOOM_MIN, ZOOM_MAX);
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
  const zoom = clamp(transform.zoom, ZOOM_MIN, ZOOM_MAX);
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
  const zoom = clamp(requestedZoom, ZOOM_MIN, ZOOM_MAX);
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
