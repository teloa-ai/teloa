# 来源与第三方许可

固件代码、Teloa 新增固件逻辑和 Python 工具使用根目录 [MIT LICENSE](LICENSE)，以下内容保留各自许可。

| 内容 | 来源 | 许可与声明 |
| --- | --- | --- |
| 通用固件、ESP-VoCat 驱动和语言/音频资源（下列单独声明除外） | `78/xiaozhi-esp32`，固定版本见 `upstream.lock.json` | MIT，根 LICENSE 保留原作者版权 |
| `main/boards/espressif/esp-vocat/touch.h` | Copyright 2023 Espressif Systems (Shanghai) CO LTD | [Apache-2.0](licenses/Apache-2.0.txt)，保留原 SPDX 版权头 |
| `artwork/companion/*.webp`、`main/teloa/assets/*.png` 和 `*.rgba` | Teloa 社区版 `packages/client/ui-workbench/src/brand/companion` | Copyright 2026 Teloa contributors；[Apache-2.0](licenses/Apache-2.0.txt)，转换不改变素材许可 |
| `artwork/companion/frames/*.png`、`main/teloa/assets/mascot.pet` | 基于上述 Teloa 角色参考制作并获准采用的生产连续帧；输入与成品摘要见 `frames/provenance.json`、`mascot-manifest.json` | Teloa 项目素材按 [Apache-2.0](licenses/Apache-2.0.txt) 提供；不授予角色名称与商标权 |
| `main/teloa/assets/teloa_cjk_20.c` | LVGL 9.5.0 自带 Source Han Sans | [SIL OFL 1.1](main/teloa/assets/OFL-font.txt)，原作者 Adobe，衍生名 Teloa CJK；摘要见 `font-manifest.json` |
| `main/display/lvgl_display/gif/gifdec*` | 上游随附 gifdec | 原[公共领域与无担保声明](main/display/lvgl_display/gif/LICENSE.txt) |

ESP-IDF 与 Component Manager 下载组件未复制进本源码仓。`dependencies.lock` 固定版本和摘要；构建者须保留实际分发依赖各自的许可。本表针对源码，不充当固件二进制的完整软件物料清单。

Teloa 名称和标识用于指明本项目，软件许可不授予商标权。修改版本应明确标注非官方衍生版本。社区版[商标政策](https://github.com/teloa-ai/teloa/blob/main/TRADEMARK.md)适用于对应名称与标识。
