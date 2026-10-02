# Third-Party Notices

This file inventories the open-source software distributed with or used to
build Teloa, grouped by license. It was generated with:

```sh
pnpm licenses list --json --prod   # production dependency graph
pnpm licenses list --json          # full graph, used only for the DSH section below
```

- Environment: pnpm 11.7.0, Node.js v24.15.0, regenerated 2026-10-02 from
  the frozen workspace install on darwin-arm64.
- The `--prod` graph covers installed workspace production dependencies,
  including optional packages selected on this platform, while excluding
  workspace `devDependencies` such as TypeScript, Vite and test runners.
  The npm installer has a separate `npm-shrinkwrap.json`; that lock is the
  source for its exact runtime and other-platform optional versions.
- `@deepseek-ai/*` (DeepSeek Harness, "DSH") is declared as a root
  `devDependency` in `package.json` for workspace-tooling reasons, but DSH is
  the runtime host Teloa plugs into and ships alongside in practice. It is
  therefore inventoried in its own section below from the full dependency
  graph rather than the `--prod` one, so its packages are not missed.
- The tables below record the license identifier reported by pnpm for each
  installed package. `buildcheck`, `cpu-features` and `ssh2` have no manifest
  `license` field, although their installed packages include a `LICENSE`
  file. Where a package includes a standalone
  `LICENSE`/`LICENSE.md`/`COPYING` file, that file supplies its exact terms.
  Installed package directories without such a top-level file are listed
  below. Fixed-version source files for the ten current darwin-arm64
  production entries are collected in `third-party-licenses/`, with source
  revisions and SHA-256 hashes; their manifest labels alone are not treated
  as replacement license text.
  Common license texts appear near the end of this file, but that section
  is not a complete copy of every package's license.

## Needs attention

- **`argparse@2.0.1`** (production dependency, pulled in transitively) declares
  license `Python-2.0`; its installed package contains `LICENSE`. The table
  below retains the identifier reported by its manifest.
- **`@deepseek-ai/node-addon-system@0.1.2`** (DSH section): `package.json`
  declares `"license": "BSD-3-Clause"`, but the bundled `LICENSE` file for
  this specific package (not its platform-specific `-darwin-arm64` sibling,
  which does carry BSD-3-Clause text) contains MIT license text with
  `Copyright (c) 2026 DeepSeek`. The metadata and installed file disagree;
  this inventory records the manifest label and does not resolve the mismatch.
- **`@deepseek-ai/node-addon-system-darwin-arm64@0.1.2`** ships a `LICENSE`
  file whose copyright line reads "Copyright (c) 2026, node-addon-landlock-run
  contributors". The text is present, but its copyright-holder line names
  a sibling native-addon package.
- The current `--prod` graph includes manifest labels `LGPL-3.0-or-later`
  (`@img/sharp-libvips-darwin-arm64`), `MPL-2.0` (`@ubjs/*`) and
  `MIT AND MPL-2.0` (`@trycua/cua-driver-darwin-arm64`). The DSH full graph
  also includes `@deepseek-ai/libreoffice-kit*` under `MPL-2.0`.
- The following installed package directories have no top-level
  `LICENSE`, `LICENCE` or `COPYING` file. Their labels below come from
  package manifests. For the ten current production entries, consult
  `third-party-licenses/README.md` and its fixed-source manifest rather than
  inferring terms from these labels.

  | Installed package | Manifest license |
  |---|---|
  | `@koromix/koffi-darwin-arm64@3.1.1` | MIT |
  | `@napi-rs/keyring-darwin-arm64@2.1.0` | MIT |
  | `@trycua/cua-driver@0.28.0` | MIT |
  | `pg-types@2.2.0` | MIT |
  | `pgpass@1.0.5` | MIT |
  | `@img/sharp-libvips-darwin-arm64@1.3.3` | LGPL-3.0-or-later |
  | `@trycua/cua-driver-darwin-arm64@0.28.0` | MIT AND MPL-2.0 |
  | `@ubjs/core@0.31.0-3` | MPL-2.0 |
  | `@ubjs/node@0.31.0-3` | MPL-2.0 |
  | `@ubjs/node-darwin-arm64@0.31.0-3` | MPL-2.0 |
  | `@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.0` | MPL-2.0 |

  A bounded scan inside these installed package directories found nested
  `LICENSE`, `NOTICE` and third-party-license files under
  `@deepseek-ai/libreoffice-kit-darwin-arm64/program/LibreOfficeDev.app/Contents/Resources/`
  and `licenses/`. The LibreOffice `LICENSE` file itself mentions MPL and
  LGPL. `@trycua/cua-driver-darwin-arm64` contains
  `node-runtime-NOTICE.md`, which identifies an embedded uniffi N-API runtime
  under MPL-2.0; it is not a substitute for the Cua package's MIT source
  license. `pg-types` and `pgpass` each contain an MIT license section in
  their README. The sharp-libvips package README contains its upstream
  third-party library notice, including the LGPL later-version explanation.
  No license-like filename was found within five directory levels of the
  remaining entries, including `@img/sharp-libvips-darwin-arm64` and
  `@ubjs/*`. This is only a file-location finding: license or notice text can
  also appear in README files or fixed-version upstream sources.

## On-demand installed at runtime: @larksuiteoapi/node-sdk 1.74.0 (MIT)

- Package: `@larksuiteoapi/node-sdk@1.74.0`, MIT, Copyright (c) 2022 Lark
  Technologies Pte. Ltd. (license text: see the MIT block under "License texts").
- **Not distributed** with Teloa and not declared in any `package.json` or the
  lockfile. It is installed only when the user adds a Feishu channel: the host
  writes the bundled lockfile
  (`packages/harness-dsh/src/managed-package-locks/larksuiteoapi__node-sdk@1.74.0.package-lock.json`,
  npm lockfile v3, every entry pinned with `integrity`) into a staging directory and runs
  `npm ci --ignore-scripts --no-audit --no-fund` (directory mode 0700, minimal npm
  environment), then checks every installed entry's name/version/integrity against
  that lockfile before renaming the staging directory to
  `<runtime>/packages/@larksuiteoapi__node-sdk@1.74.0`; top-level integrity is
  `sha512-K2WoGy6x97u2kPPSFsu0v9X8CY+0q4OwO3rhXiOSRXYjGS7ovydFpEH07AS5VYcBnbQCoc5sGezo0IEGVViuoA==`.
  `teloaWork.packages.install` accepts only this exact
  package/version/integrity (`packages/harness-dsh/src/managed-package-install.ts`).
- Its own dependencies (`axios`, `ws`, `qs`, `protobufjs`, `lodash.merge`,
  `lodash.pickby`, `lodash.identity` and their transitive dependencies) are pinned
  by that lockfile. `protobufjs` declares a `postinstall` script; it is skipped
  because the install always runs with `--ignore-scripts`.

## Production dependencies (non-DSH)

204 packages in the installed darwin-arm64 `pnpm licenses list --json --prod`
graph, excluding `@deepseek-ai/*` and packages listed only in the separate
business-dashboard chart section. Two packages shared with that section may
appear in both tables. This is the frozen workspace install; the npm
shrinkwrap is authoritative for the published installer and may select a
different optional platform package version.

### MIT (160 packages)

| Package | Version(s) |
|---|---|
| `@babel/code-frame` | 7.29.7 |
| `@babel/helper-validator-identifier` | 7.29.7 |
| `@eslint-community/regexpp` | 4.12.2 |
| `@hono/node-server` | 2.1.1 |
| `@img/colour` | 1.1.0 |
| `@keyv/serialize` | 1.1.1 |
| `@koromix/koffi-darwin-arm64` | 3.1.1 |
| `@modelcontextprotocol/client` | 2.0.0 |
| `@modelcontextprotocol/core` | 2.0.0 |
| `@modelcontextprotocol/sdk` | 1.30.0 |
| `@napi-rs/keyring` | 2.1.0 |
| `@napi-rs/keyring-darwin-arm64` | 2.1.0 |
| `@pgsql/quotes` | 18.2.4 |
| `@pgsql/types` | 18.0.0 |
| `@sec-ant/readable-stream` | 0.4.1 |
| `@sindresorhus/is` | 7.2.0 |
| `@sindresorhus/merge-streams` | 4.0.0 |
| `@standard-schema/spec` | 1.1.0 |
| `@trycua/cua-driver` | 0.28.0 |
| `@types/http-cache-semantics` | 4.2.0 |
| `@types/node` | 24.0.0 |
| `accepts` | 2.0.0 |
| `ajv` | 8.20.0 |
| `ajv-formats` | 3.0.1 |
| `body-parser` | 2.3.0 |
| `byte-counter` | 0.1.0 |
| `bytes` | 3.1.2 |
| `cacheable-lookup` | 7.0.0 |
| `cacheable-request` | 13.0.19 |
| `call-bind-apply-helpers` | 1.0.2 |
| `call-bound` | 1.0.4 |
| `chokidar` | 4.0.3, 5.0.0 |
| `clsx` | 2.1.1 |
| `content-disposition` | 1.1.0 |
| `content-type` | 1.0.5, 2.1.0 |
| `cookie` | 0.7.2 |
| `cookie-signature` | 1.2.2 |
| `cors` | 2.8.6 |
| `cross-spawn` | 7.0.6 |
| `debug` | 4.4.3 |
| `decompress-response` | 10.0.0 |
| `depd` | 2.0.0 |
| `dunder-proto` | 1.0.1 |
| `ee-first` | 1.1.1 |
| `encodeurl` | 2.0.0 |
| `es-define-property` | 1.0.1 |
| `es-errors` | 1.3.0 |
| `es-object-atoms` | 1.1.2 |
| `escape-html` | 1.0.3 |
| `etag` | 1.8.1 |
| `eventsource` | 3.0.7 |
| `eventsource-parser` | 3.1.1 |
| `execa` | 10.0.1 |
| `express` | 5.2.1 |
| `express-rate-limit` | 8.7.0 |
| `fast-deep-equal` | 3.1.3 |
| `figures` | 6.1.0 |
| `finalhandler` | 2.1.1 |
| `form-data-encoder` | 4.1.0 |
| `forwarded` | 0.2.0 |
| `fresh` | 2.0.0 |
| `function-bind` | 1.1.2 |
| `get-intrinsic` | 1.3.0 |
| `get-proto` | 1.0.1 |
| `get-stream` | 9.0.1 |
| `gopd` | 1.2.0 |
| `got` | 14.6.6 |
| `has-symbols` | 1.1.0 |
| `hasown` | 2.0.4 |
| `hono` | 4.13.7 |
| `http-errors` | 2.0.1 |
| `http2-wrapper` | 2.2.1 |
| `iconv-lite` | 0.6.3, 0.7.3 |
| `ip-address` | 10.7.0 |
| `ipaddr.js` | 1.9.1 |
| `is-plain-obj` | 4.1.0 |
| `is-promise` | 4.0.0 |
| `is-stream` | 4.0.1 |
| `is-unicode-supported` | 2.1.0 |
| `jose` | 6.2.12 |
| `js-tokens` | 4.0.0 |
| `js-yaml` | 4.3.2 |
| `json-schema-traverse` | 1.0.0 |
| `keyv` | 5.6.0 |
| `koffi` | 3.1.1 |
| `libpg-query` | 18.1.5 |
| `loose-envify` | 1.4.0 |
| `lowercase-keys` | 3.0.0 |
| `math-intrinsics` | 1.1.0 |
| `media-typer` | 1.1.1 |
| `merge-descriptors` | 2.0.0 |
| `mime-db` | 1.54.0 |
| `mime-types` | 3.0.2 |
| `mimic-response` | 4.0.0 |
| `ms` | 2.1.3 |
| `negotiator` | 1.1.0 |
| `node-addon-api` | 7.1.1 |
| `node-addon-native-custom-loader` | 0.1.6 |
| `node-addon-require-builtin` | 0.1.6 |
| `node-addon-require-builtin-darwin-arm64` | 0.1.6 |
| `node-pty` | 1.2.0-beta.15 |
| `normalize-url` | 8.1.1 |
| `npm-run-path` | 6.0.0 |
| `object-assign` | 4.1.1 |
| `object-inspect` | 1.13.4 |
| `on-finished` | 2.4.1 |
| `p-cancelable` | 4.0.1 |
| `parse-ms` | 4.0.0 |
| `parseurl` | 1.3.3 |
| `path-key` | 3.1.1, 4.0.0 |
| `path-to-regexp` | 8.4.2 |
| `pg` | 8.23.0 |
| `pg-cloudflare` | 1.4.0 |
| `pg-connection-string` | 2.14.0 |
| `pg-pool` | 3.14.0 |
| `pg-protocol` | 1.16.0 |
| `pg-types` | 2.2.0 |
| `pgpass` | 1.0.5 |
| `pgsql-deparser` | 18.3.8 |
| `picomatch` | 4.0.7 |
| `pkce-challenge` | 5.0.1 |
| `postgres-array` | 2.0.0 |
| `postgres-bytea` | 1.0.1 |
| `postgres-date` | 1.0.7 |
| `postgres-interval` | 1.2.0 |
| `pretty-ms` | 9.3.1 |
| `proxy-addr` | 2.0.7 |
| `quick-lru` | 5.1.1 |
| `range-parser` | 1.3.0 |
| `raw-body` | 3.0.2 |
| `react` | 18.3.1 |
| `readdirp` | 4.1.2, 5.1.1 |
| `require-from-string` | 2.0.2 |
| `resolve-alpn` | 1.2.1 |
| `resolve.exports` | 2.0.3 |
| `responselike` | 4.0.2 |
| `router` | 2.2.0 |
| `safer-buffer` | 2.1.2 |
| `send` | 1.2.1 |
| `serve-static` | 2.2.1 |
| `shebang-command` | 2.0.0 |
| `shebang-regex` | 3.0.0 |
| `side-channel` | 1.1.1 |
| `side-channel-list` | 1.0.1 |
| `side-channel-map` | 1.0.1 |
| `side-channel-weakmap` | 1.0.2 |
| `statuses` | 2.0.2 |
| `strip-final-newline` | 4.0.0 |
| `toidentifier` | 1.0.1 |
| `type-is` | 2.1.0 |
| `undici` | 8.10.2 |
| `undici-types` | 7.8.0 |
| `unicorn-magic` | 0.3.0 |
| `unpipe` | 1.0.0 |
| `vary` | 1.1.2 |
| `which-command` | 0.1.0 |
| `ws` | 8.21.3 |
| `xtend` | 4.0.2 |
| `yoctocolors` | 2.2.0 |
| `zod` | 4.5.4 |

### BSD-3-Clause (3 packages)

| Package | Version(s) |
|---|---|
| `@zip.js/zip.js` | 2.14.0 |
| `fast-uri` | 3.1.7 |
| `qs` | 6.16.0 |

### Apache-2.0 (18 packages)

| Package | Version(s) |
|---|---|
| `@huggingface/tokenizers` | 0.2.0 |
| `@img/sharp-darwin-arm64` | 0.35.4 |
| `@opentelemetry/api` | 1.9.1 |
| `@opentelemetry/api-logs` | 0.220.0 |
| `@opentelemetry/core` | 2.9.0, 2.11.0 |
| `@opentelemetry/otlp-exporter-base` | 0.220.0 |
| `@opentelemetry/otlp-transformer` | 0.220.0 |
| `@opentelemetry/resources` | 2.9.0, 2.11.0 |
| `@opentelemetry/sdk-logs` | 0.220.0 |
| `@opentelemetry/sdk-metrics` | 2.9.0 |
| `@opentelemetry/sdk-trace` | 2.9.0 |
| `@opentelemetry/semantic-conventions` | 1.43.0 |
| `@playwright/mcp` | 0.0.80 |
| `detect-libc` | 2.1.2 |
| `human-signals` | 8.0.1 |
| `playwright` | 1.63.0-alpha-2026-08-31 |
| `playwright-core` | 1.63.0-alpha-2026-08-31 |
| `sharp` | 0.35.4 |

### LGPL-3.0-or-later (1 package)

| Package | Version(s) |
|---|---|
| `@img/sharp-libvips-darwin-arm64` | 1.3.3 |

### MIT AND MPL-2.0 (1 package)

| Package | Version(s) |
|---|---|
| `@trycua/cua-driver-darwin-arm64` | 0.28.0 |

### MPL-2.0 (3 packages)

| Package | Version(s) |
|---|---|
| `@ubjs/core` | 0.31.0-3 |
| `@ubjs/node` | 0.31.0-3 |
| `@ubjs/node-darwin-arm64` | 0.31.0-3 |

### Python-2.0 (1 package)

| Package | Version(s) |
|---|---|
| `argparse` | 2.0.1 |

### ISC (14 packages)

| Package | Version(s) |
|---|---|
| `inherits` | 2.0.4 |
| `isexe` | 2.0.0 |
| `lucide-react` | 1.41.0 |
| `once` | 1.4.0 |
| `pg-int8` | 1.0.1 |
| `picocolors` | 1.1.1 |
| `semver` | 7.8.5 |
| `setprototypeof` | 1.2.0 |
| `signal-exit` | 4.1.0 |
| `split2` | 4.2.0 |
| `which` | 2.0.2 |
| `wrappy` | 1.0.2 |
| `yaml` | 2.9.0 |
| `zod-to-json-schema` | 3.25.2 |

### BSD-2-Clause (2 packages)

| Package | Version(s) |
|---|---|
| `http-cache-semantics` | 4.2.0 |
| `json-schema-typed` | 8.0.2 |

### (MIT OR CC0-1.0) (1 package)

| Package | Version(s) |
|---|---|
| `type-fest` | 4.41.0 |

## Business dashboard charts (`vega`, `vega-lite`, `vega-interpreter`)

79 packages: the three chart libraries added for business dashboards in
`packages/client/ui-workbench` (pinned with `--save-exact`) and their full
transitive dependency graph, resolved from the installed `node_modules`
tree on 2026-09-26 (pnpm 11.7.0, darwin-arm64). They are compiled into the
lazily loaded `client.chart.js` chunk of the workbench client rather than
shipped as npm runtime dependencies; the graph is listed in full (including
packages only used by the `vega-lite` command-line entry, such as `yargs`)
so nothing that may end up in the chunk is missed. Every package ships its
own license file under `node_modules/<package>/`.

`tslib@2.8.1` is `0BSD` and `robust-predicates@3.0.3` is `Unlicense`
(public-domain dedication); both are permissive with no attribution
requirement and their texts are included under License texts below.
`iconv-lite@0.6.3` (MIT) is a second version alongside the `0.7.3` listed
above.

### BSD-3-Clause (35 packages)

| Package | Version(s) |
|---|---|
| `d3-ease` | 3.0.1 |
| `rw` | 1.3.3 |
| `vega` | 6.4.0 |
| `vega-canvas` | 2.0.0 |
| `vega-crossfilter` | 5.1.3 |
| `vega-dataflow` | 6.1.3 |
| `vega-encode` | 5.2.2 |
| `vega-event-selector` | 4.0.0 |
| `vega-expression` | 6.1.0, 6.2.2 |
| `vega-force` | 5.1.3 |
| `vega-format` | 2.1.3 |
| `vega-functions` | 6.2.0 |
| `vega-geo` | 5.1.3 |
| `vega-hierarchy` | 5.1.3 |
| `vega-interpreter` | 2.3.2 |
| `vega-label` | 2.1.3 |
| `vega-lite` | 6.4.3 |
| `vega-loader` | 5.1.3 |
| `vega-parser` | 7.1.3 |
| `vega-projection` | 2.1.3 |
| `vega-regression` | 2.1.3 |
| `vega-runtime` | 7.1.3 |
| `vega-scale` | 8.1.3 |
| `vega-scenegraph` | 5.3.0 |
| `vega-selections` | 6.1.5 |
| `vega-statistics` | 2.0.0 |
| `vega-time` | 3.3.0 |
| `vega-transforms` | 5.2.2 |
| `vega-typings` | 2.3.0 |
| `vega-util` | 2.1.3 |
| `vega-view` | 6.2.0 |
| `vega-view-transforms` | 5.2.2 |
| `vega-voronoi` | 5.1.3 |
| `vega-wordcloud` | 5.1.3 |

### ISC (26 packages)

| Package | Version(s) |
|---|---|
| `cliui` | 9.0.1 |
| `d3-array` | 3.2.4 |
| `d3-color` | 3.1.0 |
| `d3-delaunay` | 6.0.4 |
| `d3-dispatch` | 3.0.1 |
| `d3-dsv` | 3.0.1 |
| `d3-force` | 3.0.0 |
| `d3-format` | 3.1.2 |
| `d3-geo` | 3.1.1 |
| `d3-geo-projection` | 4.0.0 |
| `d3-hierarchy` | 3.1.2 |
| `d3-interpolate` | 3.0.1 |
| `d3-path` | 3.1.0 |
| `d3-quadtree` | 3.0.1 |
| `d3-scale` | 4.0.2 |
| `d3-scale-chromatic` | 3.1.0 |
| `d3-shape` | 3.2.0 |
| `d3-time` | 3.1.0 |
| `d3-time-format` | 4.1.0 |
| `d3-timer` | 3.0.1 |
| `delaunator` | 5.1.0 |
| `get-caller-file` | 2.0.5 |
| `internmap` | 2.0.3 |
| `topojson-client` | 3.1.0 |
| `y18n` | 5.0.8 |
| `yargs-parser` | 22.0.0 |

### MIT (16 packages)

| Package | Version(s) |
|---|---|
| `@types/estree` | 1.0.9 |
| `@types/geojson` | 7946.0.16 |
| `ansi-regex` | 6.3.0 |
| `ansi-styles` | 6.2.3 |
| `commander` | 2.20.3, 7.2.0 |
| `emoji-regex` | 10.6.0 |
| `escalade` | 3.2.0 |
| `get-east-asian-width` | 1.7.0 |
| `iconv-lite` | 0.6.3 |
| `json-stringify-pretty-compact` | 4.0.0 |
| `safer-buffer` | 2.1.2 |
| `string-width` | 7.2.0 |
| `strip-ansi` | 7.2.0 |
| `wrap-ansi` | 9.0.2 |
| `yargs` | 18.0.0 |

### 0BSD (1 package)

| Package | Version(s) |
|---|---|
| `tslib` | 2.8.1 |

### Unlicense (1 package)

| Package | Version(s) |
|---|---|
| `robust-predicates` | 3.0.3 |

## DeepSeek Harness (`@deepseek-ai/*`)

The current workspace pins the DSH baseline to `0.2.0-rc.2` in
`config/dsh-baseline.json` and `config/dsh-package-versions.json`. The 299
entries below are the installed `@deepseek-ai/*` packages from the full
`pnpm licenses list --json` graph. This full graph is listed separately
from production dependencies; it does not assert that every entry is
installed by the published npm runtime. Package versions and SPDX labels
come from the installed manifests; the package's license file, when
present, remains the source for its exact text.

### MIT (295 packages)

| Package | Version(s) |
|---|---|
| `@deepseek-ai/cordis` | 4.0.4 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.4 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.9 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.5 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.6 |
| `@deepseek-ai/cosmokit` | 1.8.5 |
| `@deepseek-ai/dsh` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-acp` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-acp-app` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-agent` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-agent-default-model` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-agent-instructions` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-agent-loop` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-agent-preset` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-agent-preset-registry` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-agent-tool-presentation` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-anonymous-user-id` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-account-controller` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-gateway` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-job-controller` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-remotes` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-session-controller` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-settings-controller` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-terminal-controller` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-workspace-controller` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-api-workspace-files` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-app-boot` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-atomic-write` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-attachment` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-attachment-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-authorization` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-base` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-bash-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-bash-sandbox` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-brand` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-browser-use` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-chunked-list` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-connection` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-file-upload` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-hmr` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-locale` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-modules` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-product-analytics` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-resources` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-shortcuts` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-store` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-agent-preset` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-approval` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-attachment` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-brand-official` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-chat` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-commands` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-conversation` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-cordis` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-deliverables` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-directory-picker-browse` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-directory-picker-native` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-dockkit` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-goal` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-input-trigger` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-jobs` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-layout` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-message-feedback` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-model-selection` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-open-in-app` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-permission-presets` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-plan` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-primitives` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-reference` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-renderer` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-schedule` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-session` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-account` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-agent-loop` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-general` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-models` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-session-log` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-shell` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-subagent` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-settings-web-search` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-shortcuts` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-sidebar` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-sidebar-browser` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-sidebar-files` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-sidebar-terminal` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-skill` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-slots` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-subagent` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-theme` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-tool` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-trajectory` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-user-questions` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-workflow-run` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-workspace` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-cmdline` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-command-compact` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-command-feedback` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-command-goal` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-commands` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-compaction` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-compaction-basic` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-compaction-image-offload` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-computer-use` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-config-editor` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-cordis-client-runner` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-cordis-host-runner` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-credentials` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-credentials-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-deepseek-account` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-deepseek-account-platform` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-deepseek-llm-api-extensions` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-deque` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-agent-team` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-api-speech-to-text` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-auto-review` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-browser-use-runtime` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-client-ui-agent-team` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-client-ui-voice-input` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-schedule-bundle` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-speech-to-text` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-file-reference` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-file-reference-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-fs` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-fs-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-fs-observation-policy` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-fs-sandbox` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-fs-ssh` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-goal` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-goal-round-driver` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-headless` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-hmr` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-home-paths` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-hook-protocol` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-hooks-claude-code` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-hooks-codex` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-directory-picker` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-directory-picker-auto` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-directory-picker-browse` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-directory-picker-native` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-frontend-static` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-open-in-app` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-plugin-inventory` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-product-telemetry-otel` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-host-webserver` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-http-proxy` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-invariants` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-jobs` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-jobs-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-launch-environment` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-lazy-require` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-llm` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-llm-deepseek` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-llm-deepseek-account` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-llm-deepseek-api-key` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-llm-pi-ai` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-llm-retry` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-mcp-client` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-mcp-resources` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-message-feedback` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-native-command` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-office-to-pdf` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-otel` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-output-retention` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-package-manifest` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-permission-presets` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-persona` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-plan-mode` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-plugin-manager` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-plugin-package-inventory-deepseek` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-ptc-runtime` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-ptc-runtime-node` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-pwsh-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-pwsh-sandbox` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-repeat-tool-reminder` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sandbox` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sandbox-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sandbox-policy` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sandbox-ssh` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sandbox-windows-acl` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-schedule` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-scope` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sdk-app` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sdk-minimal` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-sdk-protocol` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-checkpoint-policy` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-format` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-format-catalog` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-format-v0-to-v1` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-format-v1-to-v2` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-format-v2-to-v3` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-format-v3-to-v4` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-log-deepseek` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-log-export` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-persistence` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-projection` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-projection-cache` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-query` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-query-sqlite` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-reference` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-stats` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-telemetry` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-telemetry-otel` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-title` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-title-first-prompt-llm` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-title-llm` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-session-turn-outline` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-settings` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-shell` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-shell-env` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-skill` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-skill-badge` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-skill-filesystem` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-skill-office` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-spill` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-spill-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-spill-policy` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-ssh` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-storage` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-storage-domain` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-storage-json` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-subagent` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-subagent-fork-in-process` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-subagent-in-process-driver` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-subagent-spawn-in-process` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-subprocess` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-subprocess-local` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-subprocess-ssh` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-system-prompt` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-terminal` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-terminal-bash` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-time-context` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-timeout` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tmux-context` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-token-meter` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-ask-user` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-bash` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-bash-persistent` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-call-timeout-policy` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-cordis` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-fs` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-fs-search` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-goal` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-jobs` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-present` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-pwsh` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-ralph` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-skill` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-str-replace-editor` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-subagent` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-subagent-control` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-todo` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-web` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-workflow` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tool-workspace-dependencies` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-tools` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-typert-loader` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-typert-protocol` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-typert-registry` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-user-approval` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-user-questions` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-util-code-language` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-util-crypto` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-util-time` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-util-values` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-util-workspace-path` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-web` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-web-app` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-web-fetch-http` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-web-frontend` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-web-search-deepseek` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-webhook` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-webhook-github` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-win32-process` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-workflow` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-workflow-ptc` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-workspace` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-workspace-changes` | 0.2.0-rc.2 |
| `@deepseek-ai/schemastery` | 3.18.4 |

### MPL-2.0 (2 packages)

| Package | Version(s) |
|---|---|
| `@deepseek-ai/libreoffice-kit` | 0.1.0 |
| `@deepseek-ai/libreoffice-kit-darwin-arm64` | 0.1.0 |

### BSD-3-Clause (2 packages)

| Package | Version(s) |
|---|---|
| `@deepseek-ai/node-addon-system` | 0.1.2 |
| `@deepseek-ai/node-addon-system-darwin-arm64` | 0.1.2 |

## Vendored source: dsh-im-gateway (MIT)

`packages/im-gateway` (`@teloa/im-gateway`) vendors a small subset of
[zhuiyueya/dsh-im-gateway](https://github.com/zhuiyueya/dsh-im-gateway) at
commit `c907dd5` (tag 0.3.3), MIT, Copyright (c) 2026 zhuiyueya. The upstream
`LICENSE` is copied verbatim to `packages/im-gateway/licenses/dsh-im-gateway.LICENSE`;
each vendored file starts with a two-line provenance header, and the per-file
table (upstream path, Teloa path, upstream SHA-256, modification summary) plus
the list of deliberately *not* vendored files lives in
`provenance/dsh-im-gateway.md`.

Vendored files (all under `packages/im-gateway/`):

| Upstream path | Teloa path |
|---|---|
| `src/core/split.ts` | `src/core/split.ts` |
| `src/core/format.ts` | `src/core/format.ts` |
| `src/instance-lock.ts` | `src/instance-lock.ts` |
| `src/channels/telegram.ts` | `src/channels/telegram.ts` |
| `src/channels/slack.ts` | `src/channels/slack.ts` |
| `src/channels/feishu.ts` | `src/channels/feishu.ts` |
| `tests/split.test.mjs` | `tests/split.test.mjs` |
| `tests/instance-lock.test.mjs` | `tests/instance-lock.test.mjs` |

Upstream's Feishu dependency `@larksuiteoapi/node-sdk` (MIT) is **not**
declared in any Teloa `package.json`; when a Feishu channel is added it is
installed on demand into the Teloa runtime directory with `--ignore-scripts`
and integrity verification against a pinned version, and is recorded here by
hand rather than by `pnpm licenses` (see "On-demand installed at runtime" above).

## License texts

Reference texts for the common identifiers below. This section does not
reproduce every installed package's exact license or the newly listed
  LGPL/MPL terms. Use the package's own files where present, plus the
  fixed-source materials in `third-party-licenses/` for the ten current
  darwin-arm64 production packages listed under "Needs attention".

### MIT

```
MIT License

Copyright (c) <year> <copyright holder>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD-3-Clause

```
BSD 3-Clause License

Copyright (c) <year>, <copyright holder>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

### BSD-2-Clause

```
BSD 2-Clause License

Copyright (c) <year>, <copyright holder>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

### ISC

```
ISC License

Copyright (c) <year>, <copyright holder>

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### 0BSD (`tslib` only)

```
Copyright (c) Microsoft Corporation.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### Unlicense (`robust-predicates` only)

```
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org>
```

### Python-2.0 (`argparse` only)

Not reproduced here due to length (~200 lines of PSF release history plus
license grant). See `node_modules/argparse/LICENSE` in any installed tree,
or <https://docs.python.org/3/license.html> for the canonical text. Summary:
OSI-approved, permits use, modification, and redistribution including in
proprietary and GPL-licensed works; imposes no obligation beyond retaining
the license text.
