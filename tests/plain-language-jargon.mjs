// 面向用户文案的白话禁词表（界面用词对照见 docs-site/reference/glossary.md）。
// 第二轮（2026-09-28）加入：宿主、凭据、运行时（「运行时间」「运行时长」除外）、Harness（产品名 DeepSeek Harness 除外）、发行、校验值义的「摘要」及各语种对应说法，
// 文档站复审（2026-09-28）补：中文「镜像摘要」、英文复数 harnesses；
// 以及外语里的 runtime 类说法（en runtime、ja ランタイム、ko 런타임、de Laufzeit 等）；zh-Hant「憑證」不拦证书义（來源憑證、SSL 憑證等）；
// 「摘要」只拦校验值义的搭配（内容摘要、文件摘要、摘要不一致等），「来源未提供摘要」「调度摘要」这类概要义照常使用；
// {host}{digest} 等占位符、http(s)://host[:port] 地址格式、teloa credentials 命令名不算。
// 应用十语词条、宿主确认卡与拒绝理由、市场站 copy() 文案共用这一份；只扫文案，不扫键名、字段名、错误码等机器标识。
// 第三轮（2026-09-28）加入资源类型旧叫法，统一到市场页签用词（方案、同事、技能、扩展、连接、模型、资料、任务模板）：
// 2026-10-01 用户裁定：长期身份统一为 AI 员工；AI 同事为旧称。数字员工 / 子员工、指 AI 员工的「岗位」、插件、连接器、自动计划、中文界面的 Skill，以及各语种对应说法
// （en digital employee / teammate / plugin / connector，ja デジタル従業員 / プラグイン / コネクタ，de Teammitglied / Plugin / Konnektor 等）；
// 「岗位」只拦指同事本身的用法，职位义的「通用岗位」「选个岗位」「岗位使命」「岗位与能力」「岗位职责」「以…的岗位身份回答」照常使用；
// 「连接器件」是硬件义，不拦；en 另拦 role memory / role's 这类把同事叫 role 的固定搭配（{role} 占位符不算）；
// SKILL.md 文件名、{skills} 占位符、skills.sh 这类站点与路径不算；德语沿用 Skill（Fähigkeit 已用作「能力」），不拦。
// 规则按「带语境的写法」收窄：例如「固定」只拦版本锁定义的搭配，「声明」只拦工程用法，en 的 receipt 只拦执行回执义，
// 这样「固定资产」「固定时间」「隐私声明」「付款收据」等日常说法不会被误伤。

/** 各语种禁词；命中即说明新增文案带回了旧工程术语。 */
export const plainLanguageJargon = {
  'zh-CN': /工件|制品|快照|钉版|指纹|上游|下游|载荷|(?<!返)回执|桩(?!号)|夹具|投影|实例|目录外|固定 ?(?:版本|内容|来源|成果|资料|知识|文件|提交|commit|快照|摘要|Skill|稿件|目标|输入|配置|方法|技能|引用|目录|包|依据|信息|数据范围|业务对象|定义|交付)|(?:已|待)固定|(?:已|未|尚未)声明|声明(?:技能|依赖|权限|字段|种类|指纹|地址|正文|名称|的)|(?:业务|资源|来源|信任|密钥|连接|工具|用途|能力|正文|配方)声明|固定 ?(?:bundleHash|trustHash)|宿主|凭据|运行时(?!间|长)|(?<!DeepSeek )Harness|发行|(?:目录|校验|内容的?|文件|镜像|安装包的?|来源的?|正文|完整性|整包|定义|草案|SKILL\.md |锁定[^，。；]{0,6}的)摘要|摘要(?:与|对不上|不一致|已变化|不同)|数字员工|子员工|AI ?同事|(?<!通用|选个|名字、)岗位(?!使命|与能力|身份回答|职责)|插件|连接器(?!件)|自动计划|Skill(?!\.md)/,
  'zh-Hant': /工件|製品|快照|釘版|指紋|上游|下游|載荷|(?<!返)回執|樁|夾具|投影|實例|執行個體|目錄外|固定 ?(?:版本|內容|來源|成果|資料|知識|檔案|文件|提交|commit|快照|摘要|Skill|稿件|目標|輸入|設定|方法|技能|引用|目錄|套件|依據|資訊|資料範圍|業務物件|定義|交付)|(?:已|待)固定|(?:已|未|尚未)(?:聲明|宣告)|(?:聲明|宣告)(?:技能|依賴|權限|欄位|種類|指紋|地址|正文|名稱|的)|(?:業務|資源|來源|信任|密鑰|金鑰|連線|工具|用途|能力|正文|配方)(?:聲明|宣告)|固定 ?(?:bundleHash|trustHash)|宿主|Teloa ?主機|憑據|(?<!來源|伺服器|網站|根|SSL ?|TLS ?)憑證|運行時(?!間|長)|執行階段|(?<!DeepSeek )Harness|發行|(?:目錄|校驗|內容的?|檔案|文件|安裝包的?|來源的?|正文|完整性|整包|定義|草案|SKILL\.md |鎖定[^，。；]{0,6}的)摘要|摘要(?:與|對不上|不一致|已變化|不同)|數位員工|數字員工|子員工|崗位|插件|外掛|連接器|連線器|自動計畫|自動計劃|Skill(?!\.md)/,
  en: /artifact|\bpinned\b|\bpinning\b|\bpins (?:the|its|their|this)\b|manifest(?! title)|snapshot|upstream|downstream|payload|fingerprint|\b(?:acceptance|effect|outcome|operation|original|demo|conversation) receipts?\b|\breceipts? (?:was|were|is) interrupted|\binstances?\b|\bstubs?\b|fixture|projection|\b(?:un)?declared\b|\bdeclarations?\b|(?<![{\/])\bhosts?\b(?![}\[])|(?<!teloa |\.)\bcredentials?\b|(?<!DeepSeek )\bharness(?:es)?\b|(?<![{]|daily )\bdigests?\b(?!\})|(?<!\{)\bruntimes?\b(?!\})|digital (?:employee|worker)s?|\brole memor(?:y|ies)\b|(?<!\{)\brole's\b|\bteammates?\b|(?<![{\w])plug-?ins?\b(?!\})|(?<![{\w])connectors?\b(?!\})/i,
  ja: /アーティファクト|スナップショット|スナップ|マニフェスト|アップストリーム|下流|ペイロード|インスタンス|スタブ|宣言|(?<!\/\/)ホスト|認証情報|資格情報|(?<!DeepSeek )Harness|ダイジェスト|ランタイム|デジタル(?:従業員|社員|スタッフ)|プラグイン|コネクタ|(?<![{.\/\w])Skills?(?![\w.\/}])/,
  ko: /아티팩트|스냅샷|스냅숏|스냅 샷|매니페스트|업스트림|다운스트림|페이로드|인스턴스|스텁|선언|(?<!\/\/)호스트|자격 증명|(?<!DeepSeek )Harness|다이제스트|런타임|디지털 (?:직원|인력)|플러그인|커넥터|(?<![{.\/\w])Skills?(?![\w.\/}])/,
  vi: /artifact|snapshot|ảnh chụp nhanh|bản chụp|manifest|bản kê|upstream|payload|\binstance\b|\bstub\b|khai báo|tuyên bố|biên nhận|\bghim\b|thông tin xác thực|máy chủ Teloa|(?<!DeepSeek )Harness|(?<!\{)\bdigest\b(?!\})|(?<!\{)\bruntime\b(?!\})|nhân (?:viên|sự) (?:số|kỹ thuật số)|trình cắm|(?<![{\w])plug-?ins?\b|trình kết nối|bộ kết nối|(?<![{.\/\w])Skills?(?![\w.\/}])/i,
  es: /artefacto|instantánea|snapshot|manifiesto|upstream|payload|instancia|\bstub\b|declarad|declaración|declaraciones|\brecibos?\b|(?<![{\/])\bhost\b(?![}\[])|anfitri|credenciales|(?<!DeepSeek )Harness|(?<!\{)\bdigest\b(?!\})|(?<!\{)\bruntime\b(?!\})|(?:empleados?|trabajador(?:es)?|colaborador(?:es)?) digital|(?<![{\w])plug-?ins?\b|\bconector(?:es)?\b|(?<![{.\/\w])Skills?(?![\w.\/}])/i,
  fr: /artefact|instantané|snapshot|manifeste|upstream|\baval\b|payload|\binstances?\b|\bstub\b|déclar|épingl|(?<!\/\/)hôte|(?<![{\/])\bhost\b(?![}\[])|(?<!DeepSeek )Harness|(?<!\{)\bdigest\b(?!\})|(?<!\{)\bruntime\b(?!\})|(?:employés?|collaborat(?:eur|rice)s?) (?:du )?numérique|(?<![{\w])plug-?ins?\b|\bconnecteurs?\b|(?<![{.\/\w])Skills?(?![\w.\/}])/i,
  de: /Artefakt|Snapshot|Schnappsch|Manifest(?!\))|Upstream|Payload|Instanz|\bStub\b|deklar|Quittung|angeheftet|angepinnt|gepinnt|Fixed|(?<![{\/])\bHosts?\b(?![}\[])|-Host\b|Zugangsdaten|(?<!DeepSeek )Harness|(?<!\{)\bDigest\b(?!\})|Laufzeit|(?<!\{)\bRuntime\b(?!\})|digitale[rnms]? (?:Mitarbeit|Besetzung)|Teammitglied|(?<![{\w])plug-?ins?\b|Plugin-|Konnektor|(?<![{\w])Connectors?\b/i,
  pt: /artefato|snapshot|instantâneo|manifesto|upstream|payload|instância|\bstub\b|declarad|declaração|declarações|\brecibos?\b|(?<![{\/])\bhost\b(?![}\[])|anfitri|credencia|(?<!DeepSeek )Harness|(?<!\{)\bdigest\b(?!\})|(?<!\{)\bruntime\b(?!\})|(?:funcionários?|colaborador(?:es)?|empregados?) digita|equipe digital|(?<![{\w])plug-?ins?\b|\bconector(?:es)?\b|(?<![{.\/\w])Skills?(?![\w.\/}])/i,
}

/** 英文为「锁定 / lock」义的词条，其他语种不得出现「修正 / 更正」义的误译。 */
export const lockSense = /\block(?:s|ed|ing)?\b/i
export const correctionMistranslation = {
  ja: /修正|訂正/,
  ko: /수정|정정/,
  vi: /\bsửa\b/i,
  es: /corregid|corrección|corregir/i,
  fr: /corrig/i,
  de: /korrigiert|behoben|berichtigt/i,
  pt: /corrigid|correção|corrigir/i,
}

/**
 * 豁免表：键 → 豁免理由。豁免只放界面位置义与告示义，不能借豁免放行版本锁定义的旧词。
 * 每条都写明为什么不是工程术语。
 */
export const plainLanguageExemptions = {
  'navigation.shortcuts': '左栏「已固定」分区：把条目钉在左栏的界面位置，不是版本锁定',
  'navigation.shortcut.pin': '界面操作「固定到左栏」',
  'navigation.shortcut.unpin': '界面操作「取消固定」',
  'navigation.shortcuts.more': '左栏「更多固定」折叠项',
  'business.dashboards.pin': '界面操作「固定此看板」到左栏',
  'collaboration.action.pin': '群消息置顶（Pin），界面位置义',
  'collaboration.action.unpin': '取消置顶（Unpin），界面位置义',
  'team.hire.job.pickAria': '招同事第二步的「岗位」选择组：指给同事挑的职位种类（通用、调查等），不是把同事本身叫岗位',
  'team.hire.fact.job': '工牌预览上的「岗位」一栏：显示所选职位种类，职位义，不是同事的旧叫法',
  'create.sentence.prompt.scopeWithName': '发给模型的提示词：括号里的 manifest 是该字段所在文件的机器名，模型要据此找到字段，按审查建议保留',
}
