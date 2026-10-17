# Teloa Firmware

English | [简体中文](README.zh-CN.md)

Bring Teloa's squirrel assistant to ESP32-S3 hardware. This firmware connects over the same Wi-Fi to a compatible, self-hosted Teloa Community gateway for voice tasks, result playback, the squirrel display, and explicitly authorized touch approvals.

[Build](docs/build.md) · [Pairing and protocol](docs/pairing.md) · [Recovery](docs/recovery.md)

![Teloa squirrel](main/teloa/assets/standing.png)

The default build uses Teloa's direct LAN protocol. It does not activate with, obtain startup updates from, or connect through the official Xiaozhi service. Models, ASR and TTS use your own host configuration; no API keys or free speech service are included.

The squirrel strolls, wags its tail, reads, rests and stretches while idle, and returns to its desk for work. Walking, tail motion and stretching each use 16 articulated frames. Petting is a local reaction; voice and approval buttons remain separate. Hold the top of the screen for 0.9 seconds to toggle still mode for the current boot. Listening, playback, review and pairing interrupt life animations. No online image generation is needed.

**Development source: `0.1.0-dev-b4`.** The Bubble / ESP-VoCat configuration is a candidate, not a verified hardware installation target. PCB identity, touch, microphone, speaker and full device recovery still require physical validation. No universal flashable binary or automated installer is released here. Application OTA download and the complete update flow are not implemented.

A compatible development host must implement `teloa-device/v1`, owner-approved USB pairing IPC and the native approval bridge. Do not assume the currently published Teloa npm/Docker versions support these interfaces. Firmware source and protocol are being opened independently; a compatible host release follows separately. Offline preview and compilation do not require a host.

With the pinned ESP-IDF **v6.1** installed, run `idf.py build` at the repository root. A fresh checkout selects the Teloa candidate profile automatically; a non-direct configuration is rejected. See the build guide for exact inputs and tests. Build does not write to a device.

For an offline screen demo, run `python3 tools/preview.py --output "screen-preview.html"` and open that new file in a browser. No device or credentials are used, and demo approvals have no effect.

The preview decodes the actual production pack: 54 images at 176 × 176, one RGB256 palette, separate A4 opacity, and zlib per frame. The pack is 639,263 bytes plus a 16,384-byte still fallback. Two pixel buffers and a decoder workspace are allocated once in PSRAM: 305,264 bytes (about 298 KiB, excluding LVGL and audio). The animation decoder allocates nothing per frame; allocation failure does not consume internal audio SRAM. Playback uses absolute time, skips stale frames, avoids decoding unchanged images, and reduces refresh frequency when decoding is slow. Device FPS, screen bandwidth and power remain unverified.

Production inputs and timing live in `artwork/companion`; raw atlases and generation prompts are not build inputs. Install the pinned asset requirements and run `python3 tools/build_mascot.py --check` to verify generated resources, or omit `--check` to rebuild them.

Based on [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) at `d7a1c05308fb6e116ffb44b9e2c6e67b3366302a`, with upstream attribution and original import hashes preserved. Firmware code/tools use [MIT](LICENSE); Teloa mascot assets retain Apache-2.0, the font derivative retains SIL OFL 1.1, and gifdec retains its public-domain notice. See [third-party notices](THIRD_PARTY_NOTICES.md). Software licenses do not grant Teloa trademark rights.

This public repository is a standalone, allowlisted source export from Teloa Community's `firmware/esp32`, with fresh publication history. `source-manifest.json` records the source revision and file hashes. Development has one source of truth in Community; no private development history, device backup, runtime data or credentials are included.
