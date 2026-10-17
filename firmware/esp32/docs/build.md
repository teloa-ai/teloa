# 构建与软件验证

所有命令从固件仓库根目录执行。这里只构建软件，不调用设备写入命令。

## 固定输入

- ESP-IDF v6.1，提交 `fff9895c82d744c7237be8847347bdd1b07c6643`，含递归子模块。
- 目标 `esp32s3`；默认依次读取 `sdkconfig.defaults`、`sdkconfig.defaults.esp32s3`、`profiles/teloa-bubble/sdkconfig.defaults`。
- IDF Component Manager 使用仓内 `dependencies.lock`。保留该锁，不通过删锁或升级依赖绕过构建问题。
- Python 工具依赖见 `tools/requirements.txt`；素材生成的可选依赖见 `tools/requirements-assets.txt`。

在固件仓外准备 SDK，按 Espressif 对应系统的安装要求安装编译工具：

```sh
git clone --recursive --branch v6.1 https://github.com/espressif/esp-idf.git "../esp-idf-v6.1"
git -C "../esp-idf-v6.1" rev-parse HEAD
# 核对上面的固定提交，再安装 SDK 的 ESP32-S3 工具。
"../esp-idf-v6.1/install.sh" esp32s3
. "../esp-idf-v6.1/export.sh"
idf.py build
```

Windows 使用相同固定版本对应的 Espressif 安装及导出脚本；本轮验证环境为 macOS。首次配置会按组件锁下载依赖，不调用模型。构建至少保留 20 GiB 可用空间。

默认项目名为 `teloa`，应用为 `build/teloa.bin`。新目录选择候选板型和私网直连；旧非直连配置会明确报错。保留旧配置原稿后，另建干净构建目录与 `SDKCONFIG` 路径。使用 `menuconfig` 时仍须保持 `CONFIG_TELOA_DIRECT=y`，不能据通用上游菜单宣称其他板型受支持。

## 工具测试

使用独立虚拟环境，不修改系统 Python；以下测试不打开真实串口：

```sh
python3 -m venv ".venv-tools"
".venv-tools/bin/python" -m pip install -r "tools/requirements.txt"
".venv-tools/bin/python" -m unittest discover -s "tools/tests" -p "test_*.py"
```

原生测试需要 `clang/clang++` 或 `gcc/g++`。JSON 解析测试使用 `managed_components/espressif__cjson/cJSON` 固定源码，须先完成 `idf.py reconfigure`；没有组件时该项会显示跳过，不能把跳过算作完整验证通过。

## 屏幕素材

预览使用仓内 PNG，固件使用已生成的 RGBA 与字体 C 源码，正常构建无需 Pillow。重新生成时：

```sh
".venv-tools/bin/python" -m pip install -r "tools/requirements-assets.txt"
".venv-tools/bin/python" tools/build_mascot.py
".venv-tools/bin/python" tools/build_font.py
```

六个 WebP 原图位于 `artwork/companion`，从已定稿角色复用。字体输入是锁定 LVGL 9.5.0 组件自带的 `SourceHanSansSC-Normal.otf`，衍生字体名为 Teloa CJK。`main/teloa/assets` 中两个 manifest 记录输入与输出摘要。

## 动作定义

`main/teloa/motion.json` 是动作时序、位置、姿势和节奏的唯一来源，`tools/build_motion.py` 生成固件 constexpr 表，浏览器预览直接读取同一 JSON。修改后运行 `python3 tools/build_motion.py`，检查用 `python3 tools/build_motion.py --check`。新动作不得覆盖配对或审批，也不得伪造任务进度。

正常动作最多 20 Hz，安静、配对和审批时降低为 4 Hz 检查；复用现有六张图，不增加位图帧。实体帧率、CPU、音频并行与功耗仍需实机测量。

## 编译与安装

配置启用软件签名校验和应用回滚，未启用硬件 Secure Boot、Flash 加密或 eFuse 写入。普通 `build/teloa.bin` 不是已签名发行物，IDF 生成的通用刷机参数也不是实机核对后的安装计划。签名、兼容性与恢复材料见[恢复说明](recovery.md)。
