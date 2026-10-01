# Developer Certificate of Origin

Teloa requires every commit to be signed off under the Developer Certificate
of Origin (DCO), version 1.1. Signing off certifies that you wrote the patch
or otherwise have the right to submit it under the project's license
([Apache License, Version 2.0](LICENSE)); it is not a copyright assignment.

本项目要求每次提交都附带 Developer Certificate of Origin（DCO 1.1）签署。签署是在
证明你有权按本项目的许可证（[Apache-2.0](LICENSE)）提交这份改动——通常是你自己
写的，或你有权以该许可证提交——而不是转让版权。

## How to sign off / 如何签署

Add a `Signed-off-by` trailer to your commit message, with your real name and
a working email address:

在提交信息末尾加一行 `Signed-off-by`，使用真实姓名与可联系的邮箱：

```
Signed-off-by: Jane Doe <jane@example.com>
```

Git can add this automatically with the `-s` (or `--signoff`) flag:

Git 可以用 `-s`（即 `--signoff`）自动加上这一行：

```sh
git commit -s -m "fix(client): ..."
```

If you forgot to sign off on a commit that has not been pushed or merged yet,
amend it:

如果提交时忘了签署，且还没有推送或合并，可以补签：

```sh
git commit --amend -s
```

Anonymous or pseudonymous `Signed-off-by` lines (no real name, no reachable
email) are not accepted — the sign-off is a certification tied to an
identifiable person, per the DCO text below.

不接受匿名或化名的 `Signed-off-by`（没有真实姓名、邮箱不可达）——签署是与可识别
的个人绑定的证明，见下方 DCO 正文。

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the rest of this project's
contribution workflow (branching, commit message format, commit granularity).

其余贡献流程（分支、提交信息格式、提交粒度）见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## Developer Certificate of Origin 1.1

The canonical text below is reproduced unmodified from
<https://developercertificate.org/>.

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
