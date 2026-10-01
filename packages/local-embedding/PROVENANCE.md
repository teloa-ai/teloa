# Local embedding model provenance

The bundled extension uses Qwen3-Embedding-0.6B with community-converted ONNX artifacts. Model weights are downloaded on request, not included in this repository.

- Original model: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Original revision: `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`.
- Community ONNX conversion: https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX
- ONNX revision: `c25a394dd583836952667c12f008335071b3f43d`.
- Original model license: Apache-2.0; see `LICENSE-MODEL` for the retained license and notice. The community repository has no separate license file or license metadata and identifies the original model as its base. Its artifacts are treated under the upstream Apache-2.0 terms.
- Teloa does not modify, convert, host or mirror these weights.

## Runtime artifacts

`runtime/assets.json` fixes download URLs, sizes and SHA-256 digests. The installer checks the downloaded bytes before use. The production variant is fp32; quantized evaluation variants are not production defaults.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `onnx/model.onnx` | 307161415 | `bf27b2f3f9ef9c32ca337d75b361fa99439deaeaefe82e4701b2dbd8439197cc` |
| `onnx/model.onnx_data` | 2093436928 | `f0a61604465929a27e68aa6217c8c89ec6186572f0209fdb7711adda48a9b9a9` |
| `tokenizer.json` | 11423705 | `def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a` |
| `tokenizer_config.json` | 9706 | `253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0` |

Inference uses CPU execution, 1024 dimensions, last-token pooling and L2 normalization. Inputs are capped at 512 tokens. Tokenization uses the original model's tokenizer; the appended token is 151643, which differs from `tokenizer_config.json`'s `eos_token`.

Memory requirements vary by input length and hardware. An 8 GB Mac mini has not been validated; do not treat this source snapshot as a hardware compatibility guarantee. Runtime implementation, fixed assets and package regression tests describe the supported behavior.
