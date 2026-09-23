# Native embedding fixture

`native-embedding.onnx` is an original Overlook test graph under the repository
license. It contains no downloaded or learned model weights. Regenerate with:

```sh
node tests/fixtures/embedding/generate-fixture.mjs
```

The ONNX IR 8 / opset 13 graph averages a `[1,3,224,224]` image, flattens its
channels, and multiplies by a `[3,512]` matrix with only its first entry nonzero.
The result is a 512-element vector whose first element is the average red
channel. White and black images therefore produce opposite signed unit vectors
after the application's normalization and quantization.

The native-worker tests validate loading, inference, image preprocessing,
provider fallback, quantization, and cooperative shutdown. This small fixture
does not qualify production CLIP model quality or accelerator performance.
