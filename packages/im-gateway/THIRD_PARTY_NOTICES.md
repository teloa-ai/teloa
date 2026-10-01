# Third-Party Notices — @teloa/im-gateway

## Vendored source: dsh-im-gateway (MIT)

- Source: https://github.com/zhuiyueya/dsh-im-gateway
- Commit: `c907dd5` (tag 0.3.3)
- License: MIT — Copyright (c) 2026 zhuiyueya
- License text: `licenses/dsh-im-gateway.LICENSE` (verbatim copy of upstream `LICENSE`)
- Per-file provenance (upstream path → Teloa path → upstream SHA-256 → modification summary): `provenance/dsh-im-gateway.md` at the repository root

Files derived from upstream carry a two-line provenance header (`// 源自 dsh-im-gateway（…commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。`). Only `src/channels/{telegram,slack}.ts`, `src/channels/feishu.ts`, `src/core/{split,format}.ts`, `src/instance-lock.ts` and the matching `tests/{split,instance-lock}.test.mjs` are vendored; everything else in this package is Teloa original work.

## Runtime dependencies

`@deepseek-ai/*` packages are inventoried in the repository-root `THIRD_PARTY_NOTICES.md` (DeepSeek Harness section). `@larksuiteoapi/node-sdk` (MIT) is **not** a declared dependency; it is installed on demand into the Teloa runtime directory with `npm ci --ignore-scripts` from a bundled lockfile and per-entry integrity verification of all transitive dependencies when a Feishu channel is added, and is recorded manually in the root notices file.
