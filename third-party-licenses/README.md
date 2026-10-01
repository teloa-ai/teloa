# Fixed-source license evidence for the darwin-arm64 production install

This directory preserves source license and notice files for the ten installed
production packages listed below whose package roots do not contain a
standalone `LICENSE`, `LICENCE` or `COPYING` file. `manifest.json` records the
exact installed version and declared identifier, each source URL and fixed
revision, the file's role, and its SHA-256. The inventory comes from the local
frozen pnpm install on darwin-arm64. It is not an inventory of every platform
selected by the release npm shrinkwrap or of every license in the product.
One separately labelled npm candidate version appears below because its
darwin-arm64 lock entry differs from the frozen pnpm install.

| Installed package | Recorded material |
| --- | --- |
| `@img/sharp-libvips-darwin-arm64@1.3.3` | `sharp-libvips-1.3.3-versions.json`, `sharp-libvips-1.3.3-THIRD-PARTY-NOTICES.md`, `sharp-libvips-1.3.3-build-LICENSE.txt`, `libvips-v8.18.6-LICENSE.txt`, `LGPL-3.0.txt`, `GPL-3.0.txt` |
| `@koromix/koffi-darwin-arm64@3.2.1` | `koffi-3.2.1-LICENSE.txt` |
| `@napi-rs/keyring-darwin-arm64@2.1.0` | `keyring-2.1.0-LICENSE.txt` |
| `@trycua/cua-driver@0.28.0` | `cua-driver-0.28.0-LICENSE.md` |
| `@trycua/cua-driver-darwin-arm64@0.28.0` | `cua-driver-0.28.0-LICENSE.md`, `cua-driver-0.28.0-node-runtime-NOTICE.md`, `uniffi-bindgen-0.31.0-3-LICENSE.txt`, `MPL-2.0.txt` |
| `@ubjs/core@0.31.0-3` | `uniffi-bindgen-0.31.0-3-LICENSE.txt`, `MPL-2.0.txt` |
| `@ubjs/node@0.31.0-3` | `uniffi-bindgen-0.31.0-3-LICENSE.txt`, `MPL-2.0.txt` |
| `@ubjs/node-darwin-arm64@0.31.0-3` | `uniffi-bindgen-0.31.0-3-LICENSE.txt`, `MPL-2.0.txt` |
| `pg-types@2.2.0` | `pg-types-2.2.0-README.md` (the MIT text is in its license section) |
| `pgpass@1.0.5` | `pgpass-1.0.5-README.md` (the MIT text is in its license section) |

The Koffi and keyring source license files match the corresponding installed
parent packages byte for byte. The pg-types and pgpass fixed-tag READMEs match
their installed READMEs byte for byte. The Cua `node-runtime-NOTICE.md` matches
the installed binary package byte for byte. It describes the embedded N-API
runtime derived from `uniffi-bindgen-react-native` 0.31.0-3 under MPL-2.0;
it is separate from the Cua repository's MIT license. The `@ubjs/*` source
`LICENSE` is an MPL-2.0 notice pointing to Mozilla's full text, included here
as `MPL-2.0.txt`.

The sharp-libvips binary package declares `LGPL-3.0-or-later`. Its fixed
v1.3.3 `THIRD-PARTY-NOTICES.md` lists the bundled libraries and explicitly
states that LGPLv3 use relies on the "any later version" clause of LGPLv2 or
LGPLv2.1. The packaged `versions.json` identifies libvips 8.18.6; that
version's source `LICENSE` contains LGPL-2.1 text. `LGPL-3.0.txt` and its
`GPL-3.0.txt` companion are canonical GNU texts for the package's declared
identifier. `sharp-libvips-1.3.3-build-LICENSE.txt` is Apache-2.0 for the
packaging scripts; it is **not** presented as the license for the binary or
its embedded libraries. The upstream third-party notice gives identifiers and
links for the other embedded libraries, not every library's full license text.

The inspected npm release candidate shrinkwrap instead pins
`@img/sharp-libvips-darwin-arm64@1.3.4` with the integrity recorded in
`manifest.json`. Its registry tarball was read and verified against that
integrity. It contains libvips 8.18.7 and a different third-party notice:
`sharp-libvips-1.3.4-versions.json`,
`sharp-libvips-1.3.4-THIRD-PARTY-NOTICES.md`, and
`libvips-v8.18.7-LICENSE.txt` record those fixed sources. That notice names
cairo under MPL-1.1 (v1.3.3 names MPL-2.0), so `MPL-1.1.txt` is kept
separately. This npm version is a release-lock observation, not an eleventh
package in the pnpm installed inventory. Other npm optional platform packages
have not been checked here.

These files preserve verifiable source material and factual differences; they
do not decide whether a particular distribution satisfies license terms. The
separate release package must explicitly include this directory for users to
receive it. The installer graph and non-darwin-arm64 optional binaries need
their own installed-artifact check.
