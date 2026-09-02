import { z } from 'zod';

// Edit revisions (#493, ADR-0031 §2). A revision is an immutable, versioned
// document: an ordered stack of typed, versioned operations plus provenance.
// The renderer folds a stack into the transform it draws, the derivative
// worker bakes the same transform into thumbs, and the backup manifest
// carries the document exactly as written. Parsing fails closed: an operation
// (or a document format) this build does not know is preserved but reported
// as unsupported, which blocks baking and editing without ever dropping it.

export const EDIT_REVISION_FORMAT_VERSION = 1;
export const EDIT_AUTHOR_PRODUCT = 'overlook';

/** A crop rectangle, normalized to the ORIENTED image (after rotate/flip). */
export interface EditCrop {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The effective transform a stack folds to (v1 order: rotate/flip, then crop). */
export interface EditTransform {
  readonly quarterTurns: 0 | 1 | 2 | 3;
  readonly flipped: boolean;
  readonly crop: EditCrop | null;
}

export const IDENTITY_TRANSFORM: EditTransform = { quarterTurns: 0, flipped: false, crop: null };

const unit = z.number().min(0).max(1);
const cropFields = { left: unit, top: unit, width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) };
const EPSILON = 1e-9;
const withinImage = (crop: EditCrop): boolean => crop.left + crop.width <= 1 + EPSILON && crop.top + crop.height <= 1 + EPSILON;

export const editOperationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('rotate'), version: z.literal(1), quarterTurns: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
  z.strictObject({ type: z.literal('flip'), version: z.literal(1), axis: z.enum(['horizontal', 'vertical']) }),
  z
    .strictObject({ type: z.literal('crop'), version: z.literal(1), ...cropFields })
    .refine(withinImage, { message: 'crop exceeds the image' }),
]);

export type EditOperation = z.infer<typeof editOperationSchema>;

/** Any operation shape a newer build may write: a type and an integer version. */
const foreignOperationSchema = z.looseObject({ type: z.string().min(1), version: z.number().int().positive() });

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u, 'expected a ULID');
const timestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u, 'expected an ISO-8601 UTC timestamp');

export const editRevisionDocumentSchema = z.strictObject({
  version: z.literal(EDIT_REVISION_FORMAT_VERSION),
  id: ulidSchema,
  parentId: ulidSchema.nullable(),
  operations: z.array(z.unknown()).readonly(),
  author: z.strictObject({ product: z.string().min(1), version: z.string().min(1) }),
  createdAt: timestampSchema,
  /** Reference to an imported instruction set (a sidecar); null for native edits. */
  importedFrom: z.string().min(1).nullable(),
});

export type EditRevisionDocument = z.infer<typeof editRevisionDocumentSchema>;

export type EditRevisionParse =
  | {
      readonly ok: true;
      readonly document: EditRevisionDocument;
      /** The operations this build understands, in document order. */
      readonly operations: readonly EditOperation[];
      /** Why the stack cannot be baked or edited (a newer operation), else null. */
      readonly unsupported: string | null;
    }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a revision document (JSON text or a parsed value), failing closed. */
export function parseEditRevision(input: unknown): EditRevisionParse {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'revision is not valid JSON' };
    }
  }
  if (!isRecord(raw)) return { ok: false, reason: 'revision is not an object' };
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: 'revision has no integer version' };
  }
  if (version !== EDIT_REVISION_FORMAT_VERSION) {
    return { ok: false, reason: `revision format ${String(version)} is newer than this app` };
  }
  const document = editRevisionDocumentSchema.safeParse(raw);
  if (!document.success) return { ok: false, reason: `revision is malformed: ${z.prettifyError(document.error)}` };
  const operations: EditOperation[] = [];
  let unsupported: string | null = null;
  for (const candidate of document.data.operations) {
    const known = editOperationSchema.safeParse(candidate);
    if (known.success) {
      operations.push(known.data);
      continue;
    }
    const foreign = foreignOperationSchema.safeParse(candidate);
    if (!foreign.success) return { ok: false, reason: 'revision holds a malformed operation' };
    unsupported ??= `operation "${foreign.data.type}" v${String(foreign.data.version)} is newer than this app`;
  }
  return { ok: true, document: document.data, operations, unsupported };
}

/** Deterministic JSON: object keys sorted at every depth, no whitespace. The
 * revision hash and the save no-op check are both defined over this form. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mapCropPoints(crop: EditCrop, map: (u: number, v: number) => readonly [number, number]): EditCrop {
  const corners = [
    map(crop.left, crop.top),
    map(crop.left + crop.width, crop.top),
    map(crop.left, crop.top + crop.height),
    map(crop.left + crop.width, crop.top + crop.height),
  ];
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** A crop drawn on the current view, carried through a clockwise quarter turn of that view. */
function rotateCrop(crop: EditCrop, quarterTurns: number): EditCrop {
  let result = crop;
  for (let turn = 0; turn < quarterTurns; turn += 1) result = mapCropPoints(result, (u, v) => [1 - v, u]);
  return result;
}

/** Carries a crop drawn on the current view through a rotate or flip applied
 * to that same view, so the framed pixels stay framed (the lightbox uses this
 * while the user keeps turning an already-cropped photo). */
export function carryCrop(crop: EditCrop, operation: Exclude<EditOperation, { type: 'crop' }>): EditCrop {
  if (operation.type === 'rotate') return rotateCrop(crop, operation.quarterTurns);
  return operation.axis === 'horizontal' ? mapCropPoints(crop, (u, v) => [1 - u, v]) : mapCropPoints(crop, (u, v) => [u, 1 - v]);
}

/** Folds an operation stack into the effective transform. Rotate and flip act
 * on the view as the user sees it (mirroring the lightbox: a horizontal flip
 * reverses handedness, so later turns invert in source space); a crop that
 * precedes a later rotate/flip is carried along so it still frames the same
 * pixels. */
export function foldOperations(operations: readonly EditOperation[]): EditTransform {
  let transform = IDENTITY_TRANSFORM;
  for (const operation of operations) {
    if (operation.type === 'rotate') {
      const source = transform.flipped ? (4 - operation.quarterTurns) % 4 : operation.quarterTurns;
      transform = {
        quarterTurns: ((transform.quarterTurns + source) % 4) as EditTransform['quarterTurns'],
        flipped: transform.flipped,
        crop: transform.crop === null ? null : rotateCrop(transform.crop, operation.quarterTurns),
      };
    } else if (operation.type === 'flip') {
      transform =
        operation.axis === 'horizontal'
          ? {
              ...transform,
              flipped: !transform.flipped,
              crop: transform.crop === null ? null : mapCropPoints(transform.crop, (u, v) => [1 - u, v]),
            }
          : {
              quarterTurns: ((transform.quarterTurns + 2) % 4) as EditTransform['quarterTurns'],
              flipped: !transform.flipped,
              crop: transform.crop === null ? null : mapCropPoints(transform.crop, (u, v) => [u, 1 - v]),
            };
    } else {
      const crop = { left: operation.left, top: operation.top, width: operation.width, height: operation.height };
      // A crop inside an existing crop narrows the framed region.
      transform = {
        ...transform,
        crop:
          transform.crop === null
            ? crop
            : {
                left: transform.crop.left + crop.left * transform.crop.width,
                top: transform.crop.top + crop.top * transform.crop.height,
                width: crop.width * transform.crop.width,
                height: crop.height * transform.crop.height,
              },
      };
    }
  }
  return transform;
}

/** The minimal v1 stack that folds back to `transform`. */
export function operationsFromTransform(transform: EditTransform): EditOperation[] {
  const operations: EditOperation[] = [];
  if (transform.quarterTurns !== 0) operations.push({ type: 'rotate', version: 1, quarterTurns: transform.quarterTurns });
  if (transform.flipped) operations.push({ type: 'flip', version: 1, axis: 'horizontal' });
  if (transform.crop !== null) operations.push({ type: 'crop', version: 1, ...transform.crop });
  return operations;
}

export function isIdentityTransform(transform: EditTransform): boolean {
  return transform.quarterTurns === 0 && !transform.flipped && transform.crop === null;
}

export function transformsEqual(left: EditTransform, right: EditTransform): boolean {
  return canonicalJson(operationsFromTransform(left)) === canonicalJson(operationsFromTransform(right));
}
