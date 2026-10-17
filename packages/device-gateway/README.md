# Teloa device gateway

社区版硬件直连的可选媒体组件。显式调用 `createDeviceGateway().start()` 才监听宿主选定的本机私网地址及独立端口，设备仅能使用 `/devices/v1/connect` 的有限 WSS 协议。不会连接官方小智服务，也不会自行启动 Teloa、调用模型或取得原会话权限。

宿主须提供当前绑定租约、同步撤销判据、原生输入与结果端口。连接凭据为 32 字节随机值的规范 base64url 编码，不能放在 URL。TLS 私钥、证书、凭据和 Silero 权重均由运行实例持有，不包含在本包源码中。

上行为 16 kHz/单声道/60 ms Opus。`createDeviceAudioCapture` 将有效载荷解码、分窗送入固定 Silero v6.2 模型，产生最多 15 秒的 PCM WAV；断线直接丢弃半句。模型及许可语音来源见 `silero-model.lock.json`。下行 `transcodeSpeechMp3` 使用独立 worker 流式生成 24 kHz/单声道/60 ms Opus，播放器最多提前 1980 ms，等待设备的实际播放回执。

社区宿主已接入持久 capture、原助手准入、同一 Web 通话仲裁与因果结果播报。默认不监听；只有本人运行目录中的受保护 `direct-device.json` 明确启用时，才加载固定设备绑定、私有 TLS 与 VAD 模型。USB 配对和实体硬件安装另行验收。独立协议、编解码及软件设备测试不等于真实硬件验收。

`tools/software-device.mjs` 可用私有配置模拟同一协议的设备，支持握手、上传 16 kHz mono s16le 夹具、查询和重播原 capture。它按 60 ms 消费下行音频并回报进度，输出解码 PCM，不访问 USB 或安装固件。配置文件须为本人所有的 0600 普通文件，字段包括私网 `host`、独立 `port`、预期证书 `serverName` 和设备 `credential`；同目录 `server.crt` 用作信任锚。凭据不得进入仓库、命令参数或 URL。

```sh
pnpm --filter @teloa/device-gateway build
pnpm --filter @teloa/device-gateway test
# 设置两个指向锁定材料的绝对路径后，另运行真实 ONNX 和音频集成：
TELOA_SILERO_MODEL=".../silero_vad-v6.2.onnx" TELOA_SILERO_TEST_WAV=".../silero-upstream-test.wav" pnpm --filter @teloa/device-gateway test
```

未指定固定模型材料时，真实 ONNX 用例明确跳过，不能以此声称模型验收通过。生产调用者必须将播放提供的同一 `AbortSignal` 传给语音供应商，以释放取消中的网络读取。
