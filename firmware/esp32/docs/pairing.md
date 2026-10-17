# USB 配对与局域网协议

## 接入本人宿主

需要支持本协议的 Teloa 社区版开发宿主；公开 npm/Docker 版本尚不能保证兼容。设备与宿主处于同一 Wi-Fi，宿主使用独立设备网关端口，Web 端口不承载音频。隔离联调使用独立 home/profile、数据库、设备凭据与端口，不能共用安装身份。

1. 在 Web 工作台硬件设置创建本人配对意图。基础访问与触屏审批分别授权，审批默认关闭。
2. 工作台生成意图 ID 和实例专属本机 socket。复制该实例显示的 USB 命令；`tools/pair.py` 未加 `--write-usb-config` 时只预检，不打开串口。
3. **已安装 Teloa 固件**的设备在配对窗口内接受物理确认后，助手才写入私网地址、CA、证书名称和设备凭据。意图五分钟后过期，取消后不可再用。该助手不安装固件，也不能给原厂固件写配置。
4. 设备配网并完成校验后直连宿主。在原实例撤销设备；更换实例须重新配对。

真实意图、socket 命令、私钥和凭据不要贴到公开 issue。模型和语音服务在宿主配置；自有固件不使用官方小智语音服务。

## `teloa-device/v1`

设备连接私网 IPv4 的 `wss://<host>:<port>/devices/v1/connect`，使用配对 CA、证书名称和 Bearer 凭据；证书名称、日期、签名均须有效。冷启动先向同一宿主/端口的 UDP 时间服务发送随机 nonce 和 HMAC，校验响应后建立 TLS。时间证明或认证失败时，不得关闭校验继续连接。

设备首先发送：

```json
{"type":"hello","protocol":"teloa-device/v1","audio":{"uplink":{"format":"opus","sampleRate":16000,"channels":1,"frameDurationMs":60},"downlink":{"format":"opus","sampleRate":24000,"channels":1,"frameDurationMs":60}}}
```

有界控制 JSON 的精确字段、状态和上限以 [协议实现](../main/teloa/teloa_protocol.cc)、[解析器](../main/teloa/teloa_control.cc) 及测试为准。此为开发协议，升级应同步核对两端实现。

Opus 帧有 16 字节头，数字均为网络字节序：版本 1 字节（值 1），方向 1 字节（上行 1 / 下行 2），保留 2 字节（零），连接代数、流 ID、连续序号各 4 字节，随后为 1–4096 字节负载。新连接、捕获和播放相互隔离；越界、乱序和旧连接帧不能继续播放。

屏幕只支持内置有限状态与审批卡片，不执行模型提供的脚本、HTML、任意绘图或外部图片 URL。审批须在当前卡片末页重新按住按钮 1.2 秒，移出按钮、卡片变化或断线会取消按压；宿主还会校验授权、归属、摘要、有效期和一次性票据。网页先处理的审批不会由设备重复批准。

USB 的 `@TELOA` 行协议、NVS 配置和摘要见 [teloa_pairing.cc](../main/teloa/teloa_pairing.cc) 和 [pair.py](../tools/pair.py)，不提供任意串口命令、shell 或远程刷写。
