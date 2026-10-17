# Teloa ESP-VoCat 候选驱动

本目录基于小智上游的 ESP-VoCat 驱动，保留硬件参考与原始来源记录。Teloa 将其作为星喵 Bubble 的候选适配，不能仅凭产品外观或名称认定 PCB、Flash、PSRAM、触控和音频引脚相同。

## Teloa 默认配置

本固件使用 `Teloa Firmware` 菜单和 `teloa-bubble` 默认配置，直连本人局域网宿主。屏幕使用内嵌绿色小松鼠和 Teloa 字体，不下载上游表情资源包，也不写旧 assets 分区。配置中的 32 MiB Flash 与候选分区必须与本台设备实测核对，不代表所有 ESP-VoCat 硬件的规格。

从仓库根目录按[构建指南](../../../../docs/build.md)编译。安装、分区匹配、签名和本台完整备份的前提见[恢复说明](../../../../docs/recovery.md)；当前没有经实体设备验收的通用安装流程。

## 硬件参考

上游硬件资料：[ESP-VoCat / EchoEar](https://oshwhub.com/esp-college/echoear)。这是硬件设计参考，不是本台 Bubble 已确认采用该 PCB 的证据。上游原始文件摘要仍保留在根目录 `upstream.lock.json`。

## 外设错误处理

保留上游的电池工作线程、有限 I2C 重试、有效快照和触摸读取错误处理。Teloa 直连模式在审批长按期间持续采样，读取失败会取消按压，不能合成一次批准。本机协议测试不替代触点、供电、音频和外设故障的实机验证。
