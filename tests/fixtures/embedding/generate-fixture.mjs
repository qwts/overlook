// Own deterministic test graph, encoded with ONNX's stable protobuf fields:
// https://github.com/onnx/onnx/blob/main/onnx/onnx.proto3
// No model weights, network access, or Python dependency is needed to regenerate.
import { writeFileSync } from 'node:fs';

function varint(value) {
  const bytes = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value > 0 ? 128 : 0));
  } while (value > 0);
  return Buffer.from(bytes);
}
const integer = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field, value) => {
  const body = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
};
const message = (...fields) => Buffer.concat(fields);
const node = (op, inputs, output) => bytes(1, message(...inputs.map((input) => bytes(1, input)), bytes(2, output), bytes(4, op)));
const valueInfo = (name, dimensions) =>
  message(
    bytes(1, name),
    bytes(
      2,
      bytes(
        1,
        message(
          integer(1, 1), // TypeProto.Tensor.elem_type: FLOAT
          bytes(2, message(...dimensions.map((dimension) => bytes(1, integer(1, dimension))))),
        ),
      ),
    ),
  );

// [3,512] matrix: select the average normalized red channel into output[0].
// Other outputs are zero. White/black input must produce opposite signs, so a
// constant-output graph cannot accidentally satisfy the worker regression.
const weights = Buffer.alloc(3 * 512 * 4);
weights.writeFloatLE(1, 0);
const initializer = message(integer(1, 3), integer(1, 512), integer(2, 1), bytes(8, 'weights'), bytes(9, weights));
const graph = message(
  node('GlobalAveragePool', ['pixel_values'], 'means'),
  node('Flatten', ['means'], 'channels'),
  node('MatMul', ['channels', 'weights'], 'image_embeds'),
  bytes(2, 'overlook-native-embedding-smoke'),
  bytes(5, initializer),
  bytes(11, valueInfo('pixel_values', [1, 3, 224, 224])),
  bytes(12, valueInfo('image_embeds', [1, 512])),
);
const model = message(
  integer(1, 8), // ModelProto.ir_version
  bytes(2, 'overlook-test-fixture'),
  bytes(7, graph),
  bytes(8, integer(2, 13)), // default-domain opset 13
);
writeFileSync(new URL('./native-embedding.onnx', import.meta.url), model);
