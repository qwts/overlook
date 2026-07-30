---
'overlook': patch
---

Fix a whole-app crash (SIGABRT) when switching libraries or pausing indexing while an embedding was being computed: terminating the ONNX worker mid-inference made onnxruntime throw into the torn-down worker environment. Workers now retire cooperatively — the in-flight job settles first, and a hard terminate remains only as a backstop for a wedged worker.
