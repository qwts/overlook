import { IDENTITY_TRANSFORM, isIdentityTransform, type EditCrop, type EditTransform } from '../../shared/library/edit-revision.js';

// Edits as XMP (#497, ADR-0031 §4 + §6). The Original + XMP mode ships the
// byte-identical original with a sidecar that carries the supported subset of
// the head revision in vocabularies other tools read: rotate/flip as
// `tiff:Orientation` (all eight EXIF orientations) and the crop as Camera
// Raw's `crs:Crop*` rectangle, expressed in the oriented frame. The reader
// beside the writer is the round-trip fixture the unit tests review; an
// operation this build does not know can neither bake nor serialize and is
// named in the preflight loss report, never dropped silently.

export const XMP_TIFF_NS = 'http://ns.adobe.com/tiff/1.0/';
export const XMP_CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/';

// The transform is "rotate clockwise, then mirror horizontally"; EXIF names
// the same eight results as mirror-then-rotate (F·R(θ) = R(−θ)·F).
const ORIENTATION_BY_TRANSFORM: Readonly<Record<string, number>> = {
  '0:false': 1,
  '1:false': 6,
  '2:false': 3,
  '3:false': 8,
  '0:true': 2,
  '1:true': 5,
  '2:true': 4,
  '3:true': 7,
};

export function exifOrientation(transform: Pick<EditTransform, 'quarterTurns' | 'flipped'>): number {
  return ORIENTATION_BY_TRANSFORM[`${String(transform.quarterTurns)}:${String(transform.flipped)}`] ?? 1;
}

function transformFromOrientation(orientation: number): Pick<EditTransform, 'quarterTurns' | 'flipped'> | null {
  for (const [key, value] of Object.entries(ORIENTATION_BY_TRANSFORM)) {
    if (value !== orientation) continue;
    const [turns, flipped] = key.split(':');
    return { quarterTurns: Number(turns) as EditTransform['quarterTurns'], flipped: flipped === 'true' };
  }
  return null;
}

const decimal = (value: number): string => value.toFixed(6);

/** XML attributes for the `rdf:Description` element (namespaces + values). */
export function editsXmpAttributes(transform: EditTransform): string {
  if (isIdentityTransform(transform)) return '';
  const orientation = ` xmlns:tiff="${XMP_TIFF_NS}" tiff:Orientation="${String(exifOrientation(transform))}"`;
  if (transform.crop === null) return orientation;
  const crop = transform.crop;
  return (
    `${orientation} xmlns:crs="${XMP_CRS_NS}" crs:HasCrop="True" crs:CropAngle="0"` +
    ` crs:CropLeft="${decimal(crop.left)}" crs:CropTop="${decimal(crop.top)}"` +
    ` crs:CropRight="${decimal(crop.left + crop.width)}" crs:CropBottom="${decimal(crop.top + crop.height)}"`
  );
}

/** One XMP packet carrying the edits and, optionally, Dublin Core fields. */
export function xmpPacket(descriptionAttributes: string, descriptionBody: string): Buffer {
  return Buffer.from(
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"${descriptionAttributes}>${descriptionBody}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    'utf8',
  );
}

function attribute(xml: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(xml);
  return match?.[1] ?? null;
}

/** Reads the subset the writer emits back into a transform; null when the
 * packet carries no recognizable edit. The round-trip fixture for §4. */
export function parseEditsXmp(xml: string): EditTransform | null {
  const orientationValue = attribute(xml, 'tiff:Orientation');
  const orientation = orientationValue === null ? null : transformFromOrientation(Number(orientationValue));
  const hasCrop = attribute(xml, 'crs:HasCrop') === 'True';
  let crop: EditCrop | null = null;
  if (hasCrop) {
    const left = Number(attribute(xml, 'crs:CropLeft'));
    const top = Number(attribute(xml, 'crs:CropTop'));
    const right = Number(attribute(xml, 'crs:CropRight'));
    const bottom = Number(attribute(xml, 'crs:CropBottom'));
    if ([left, top, right, bottom].some((value) => Number.isNaN(value))) return null;
    crop = { left, top, width: right - left, height: bottom - top };
  }
  if (orientation === null && crop === null) return orientationValue === null ? null : IDENTITY_TRANSFORM;
  return { ...(orientation ?? IDENTITY_TRANSFORM), crop };
}
