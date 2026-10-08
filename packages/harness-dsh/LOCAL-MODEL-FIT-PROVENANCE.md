# 本地模型内存估计来源

`src/local-model-fit.ts` 只复用 llmfit 的六条完整稠密模型架构记录、FP16 KV 公式、Q4_K_M 权重系数、运行时余量和内存比率边界。没有引入 llmfit 可执行文件、Rust 库、模型清单、排行榜、服务发现、下载或网络功能。

固定上游版本为 [llmfit v1.1.16](https://github.com/AlexsJones/llmfit/releases/tag/v1.1.16)，提交 `2ac77f5e0d13221c7e2a2414769fe62f660d225c`，Copyright (c) 2026 Alex Jones，[MIT 许可](https://github.com/AlexsJones/llmfit/blob/2ac77f5e0d13221c7e2a2414769fe62f660d225c/LICENSE)。移植源码开头保留完整版权和许可文本，分发该逻辑时必须保留。

## 复用范围

- [hf_models.json](https://github.com/AlexsJones/llmfit/blob/2ac77f5e0d13221c7e2a2414769fe62f660d225c/llmfit-core/data/hf_models.json)：`Qwen/Qwen3-4B`、`Qwen/Qwen3-8B`、`Qwen/Qwen3-14B`、`deepseek-ai/DeepSeek-R1-Distill-Qwen-7B`、`deepseek-ai/DeepSeek-R1-Distill-Qwen-14B`、`microsoft/phi-4` 的 `parameters_raw`、`num_hidden_layers`、`num_key_value_heads`、`head_dim` 和 `context_length`。
- [models.rs](https://github.com/AlexsJones/llmfit/blob/2ac77f5e0d13221c7e2a2414769fe62f660d225c/llmfit-core/src/models.rs)：`quant_bpp` 的 Q4_K_M 系数 `0.58 B/参数`；`estimate_memory_gb_with_kv` 的 `0.5 GiB` 运行时余量；`kv_cache_gb` 的 `2 × layers × KV heads × head dim × context × dtype bytes`，本实现只支持 FP16 KV。
- [fit.rs](https://github.com/AlexsJones/llmfit/blob/2ac77f5e0d13221c7e2a2414769fe62f660d225c/llmfit-core/src/fit.rs)：`pure_ratio_verdict` 的 `0.85` 和 `0.98` 比率边界。既有 `good / slow / poor` 枚举仅表达内存余量；没有移植推理速度、质量评分或运行模式判断。

权重实际体积和目录 digest 来自市场仓 `catalog/models/teloa.model.local.qwen3.json`、`teloa.model.local.deepseek-r1.json`、`teloa.model.local.phi4.json` 的既有固定 Q4_K_M 变体。匹配仅接受精确 Ollama 名称、量化和该体积；调用方仍须使用受审目录，摘要核验和下载授权由既有流程负责。

## Teloa 适配与限制

所有计算统一使用字节，修正上游权重路径的十进制 GB 与 KV 路径的 GiB 混用；权重下界取固定目录体积与参数系数估计的较大值。默认按单会话 `8192` tokens 计算，已加载模型可使用实际上下文。超过记录的模型上下文上限会明确返回 `contextSupported: false` 和 `poor`，不会静默裁剪。

没有可靠可用内存输入时，Teloa 采用物理内存的 `75%` 作为保守预算；这是 Teloa 的余量策略，未将其伪称为实测 Metal 可用量。若提供可靠可用内存，则以不超过物理总量的输入值为预算。macOS 的 Node `os.freemem()` 不能作为可靠可用内存输入。

本估计不是实际进程峰值、GPU 驻留许可或速度承诺；FP16 KV 和固定运行时余量仍是显式假设。没有完整架构元数据的 Llama/Gemma、MoE、未知量化与其他工件返回 `undefined`，由调用方保留原来的保守判断。模型许可仍以市场条目和上游模型为准，llmfit 的 MIT 许可不覆盖模型权重。
