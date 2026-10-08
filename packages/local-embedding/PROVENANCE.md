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

## EmbeddingGemma 2 through local Ollama

The extension also provides text retrieval through an already running local Ollama service. It does not install or start Ollama, change its configuration, create a chat route or download model weights when enabled. Only an explicit preparation request calls `/api/pull`. The application calls `/api/embed` for inference and rejects models whose installed manifest digest differs from the pinned value.

- Upstream model: https://huggingface.co/google/embeddinggemma-2
- Official model card: https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2
- Model license: Apache-2.0, as stated by the official EmbeddingGemma 2 model card. This does not use the license declaration from the earlier EmbeddingGemma model.
- Ollama model: https://ollama.com/library/embeddinggemma-2:latest
- Registry manifest: https://registry.ollama.ai/v2/library/embeddinggemma-2/manifests/latest
- Manifest retrieved on 2026-10-08: SHA-256 `969600645b5240cbf78f46456c819f38bea9f59c3e34a2993a0ae54334e3db04`, 341733 bytes.
- The manifest contains 1385 layers plus a 220-byte config, with a total referenced size of 1325205612 bytes. Its tensor layers identify their source as `embeddinggemma-2:740m-nvfp4`; they are not GGUF or ONNX artifacts. `latest` is checked against this exact digest after preparation and before every inference request; a changed tag fails rather than silently becoming a new index profile.

Text retrieval uses the exact prefixes `task: search result | query: ` and `title: none | text: `. The model uses mean pooling and produces 768-dimensional vectors. The provider validates finite, nonzero output, applies L2 normalization, then appends 256 zero values for the existing 1024-dimensional retrieval storage. Zero padding preserves cosine similarity. The model digest, prefixes, native and storage dimensions, normalization and padding policy are bound to a separate profile hash; these vectors cannot be substituted for a Qwen index.

Requests use a numeric HTTP loopback endpoint, by default `http://127.0.0.1:11434`, and reject redirects and remote endpoints. Explicit preparation verifies inference with the fixed short query `Teloa`, including response dimensions and normalization, before reporting ready; enabling the extension does not perform this probe. Inputs exceeding the model context are rejected with `truncate: false`. Ollama owns model memory and its five-minute keep-alive; disposing this extension cancels its requests and never stops the external service process. Cancelling preparation closes and drains this provider's pull stream; another client's independent pull is outside its lifecycle.

The model card describes image, audio and video capabilities, but this provider accepts text retrieval only. Those modalities and device-specific performance are not established by this integration.
