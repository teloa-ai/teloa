import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAIN_LOCALES,
  REGION_LOCALES,
  fallbackChain,
  resolveProductLocale,
  validateFallbackGraph,
} from '../lib/types/client/i18n/locale.js'
import {
  MESSAGE_KEYS,
  catalogs,
  regionCatalogs,
  translateMessage,
  validateCatalogs,
} from '../lib/types/client/i18n/messages.js'
import {correctionMistranslation, lockSense, plainLanguageExemptions, plainLanguageJargon} from '../../../../tests/plain-language-jargon.mjs'

const expectedKeys = [...MESSAGE_KEYS].sort()

const localizedMarketTemplateKeys = [
  'market.template.useEyebrow',
  'market.template.backToContent',
  'market.template.governance.title',
  'market.template.governance.description',
  'market.template.sourceRuntimeAria',
  'market.template.sourceRuntime.title',
  'market.template.author',
  'market.template.license',
  'market.template.runtimeOwnership',
  'market.template.runtimeOwnershipDescription',
  'market.template.connectionsRuntime',
  'market.template.manifestValidation',
  'market.template.viewRaw',
  'market.template.exportDefinition',
  'market.catalog.back',
  'market.intent.detailVersionPrefix',
  'market.skill.atomicContentAria',
  'market.skill.contentTitle',
] as const

const localizedMarketTemplateValues = {
  'zh-Hant': [
    '使用範本',
    '返回範本內容',
    '來源、執行環境與版本',
    '連線設定、共用引用、版本比較、完整匯出與原始清單',
    '範本來源與執行環境',
    '來源與執行環境',
    '作者',
    '授權條款',
    '執行環境管理',
    'Teloa 管理業務定義與使用綁定；DSH 管理原生技能、MCP 與執行環境。',
    '連線與執行環境',
    '原始清單與驗證',
    '查看原始內容與版本',
    '匯出清單定義',
    '返回市集',
    '能力使用方案 v',
    '單個技能的內容',
    '技能內容',
  ],
  en: [
    'Use template',
    'Back to template',
    'Source, environment, and version',
    'Connections, shared references, version comparison, full export, and original resource list',
    'Template source and environment',
    'Source and environment',
    'Author',
    'License',
    'Environment management',
    'Teloa manages business definitions and usage bindings; DSH manages native Skills, MCP connections, and run environments.',
    'Connections and environment',
    'Original resource list and checks',
    'View source and versions',
    'Export resource list',
    'Back to marketplace',
    'Capability plan v',
    'Content of a single skill',
    'Skill content',
  ],
  ja: [
    'テンプレートを使用',
    'テンプレートに戻る',
    'ソース・実行環境・バージョン',
    '接続、共有参照、バージョン比較、完全なエクスポート、元のリソース一覧',
    'テンプレートのソースと実行環境',
    'ソースと実行環境',
    '作成者',
    'ライセンス',
    '実行環境の管理',
    'Teloa は業務定義と利用先への紐付けを管理し、DSH はネイティブスキル、MCP 接続、実行環境を管理します。',
    '接続と実行環境',
    '元のリソース一覧と検証',
    '元の内容とバージョンを表示',
    'リソース一覧をエクスポート',
    'マーケットに戻る',
    '能力利用プラン v',
    '単独スキルの内容',
    'スキルの内容',
  ],
  ko: [
    '템플릿 사용',
    '템플릿으로 돌아가기',
    '소스, 실행 환경 및 버전',
    '연결, 공유 참조, 버전 비교, 전체 내보내기 및 원본 리소스 목록',
    '템플릿 소스 및 실행 환경',
    '소스 및 실행 환경',
    '작성자',
    '라이선스',
    '실행 환경 관리',
    'Teloa는 업무 정의와 사용 연결을 관리하고, DSH는 네이티브 스킬, MCP 연결 및 실행 환경을 관리합니다.',
    '연결 및 실행 환경',
    '원본 리소스 목록 및 검증',
    '원본 콘텐츠 및 버전 보기',
    '리소스 목록 내보내기',
    '마켓으로 돌아가기',
    '역량 활용 계획 v',
    '단일 스킬 내용',
    '스킬 내용',
  ],
  vi: [
    'Sử dụng mẫu',
    'Quay lại mẫu',
    'Nguồn, môi trường chạy và phiên bản',
    'Kết nối, tham chiếu dùng chung, so sánh phiên bản, xuất đầy đủ và danh sách tài nguyên gốc',
    'Nguồn mẫu và môi trường chạy',
    'Nguồn và môi trường chạy',
    'Tác giả',
    'Giấy phép',
    'Quản lý môi trường chạy',
    'Teloa quản lý định nghĩa nghiệp vụ và liên kết sử dụng; DSH quản lý kỹ năng gốc, kết nối MCP và môi trường chạy.',
    'Kết nối và môi trường chạy',
    'Danh sách tài nguyên gốc và xác thực',
    'Xem nội dung gốc và phiên bản',
    'Xuất danh sách tài nguyên',
    'Quay lại kho tài nguyên',
    'Kế hoạch sử dụng năng lực v',
    'Nội dung của một kỹ năng',
    'Nội dung kỹ năng',
  ],
  es: [
    'Usar plantilla',
    'Volver a la plantilla',
    'Fuente, entorno de ejecución y versión',
    'Conexiones, referencias compartidas, comparación de versiones, exportación completa y lista de recursos original',
    'Fuente de la plantilla y entorno de ejecución',
    'Fuente y entorno de ejecución',
    'Autor',
    'Licencia',
    'Gestión del entorno de ejecución',
    'Teloa gestiona las definiciones de negocio y sus asignaciones; DSH gestiona las habilidades nativas, las conexiones MCP y los entornos de ejecución.',
    'Conexiones y entorno de ejecución',
    'Lista de recursos original y validación',
    'Ver contenido original y versiones',
    'Exportar lista de recursos',
    'Volver al marketplace',
    'Plan de uso de capacidades v',
    'Contenido de una habilidad',
    'Contenido de la habilidad',
  ],
  fr: [
    'Utiliser le modèle',
    'Retour au modèle',
    'Source, environnement d’exécution et version',
    'Connexions, références partagées, comparaison des versions, export complet et liste des ressources d’origine',
    'Source du modèle et environnement d’exécution',
    'Source et environnement d’exécution',
    'Auteur',
    'Licence',
    'Gestion de l’environnement d’exécution',
    'Teloa gère les définitions métier et leurs affectations ; DSH gère les compétences natives, les connexions MCP et les environnements d’exécution.',
    'Connexions et environnement d’exécution',
    'Liste des ressources d’origine et validation',
    'Afficher le contenu source et les versions',
    'Exporter la liste des ressources',
    'Retour à la place de marché',
    'Plan d’utilisation des capacités v',
    'Contenu d’une compétence',
    'Contenu de la compétence',
  ],
  de: [
    'Vorlage verwenden',
    'Zurück zur Vorlage',
    'Quelle, Ausführungsumgebung und Version',
    'Verbindungen, gemeinsame Referenzen, Versionsvergleich, vollständiger Export und ursprüngliche Ressourcenliste',
    'Vorlagenquelle und Ausführungsumgebung',
    'Quelle und Ausführungsumgebung',
    'Autor',
    'Lizenz',
    'Verwaltung der Ausführungsumgebung',
    'Teloa verwaltet Geschäftsdefinitionen und Nutzungszuordnungen; DSH verwaltet native Skills, MCP-Verbindungen und Ausführungsumgebungen.',
    'Verbindungen und Ausführungsumgebung',
    'Ursprüngliche Ressourcenliste und Validierung',
    'Quellinhalt und Versionen anzeigen',
    'Ressourcenliste exportieren',
    'Zurück zum Marktplatz',
    'Einsatzplan für Fähigkeiten v',
    'Inhalt eines einzelnen Skills',
    'Inhalt des Skills',
  ],
  pt: [
    'Usar modelo',
    'Voltar ao modelo',
    'Origem, ambiente de execução e versão',
    'Ligações, referências partilhadas, comparação de versões, exportação completa e lista de recursos original',
    'Origem do modelo e ambiente de execução',
    'Origem e ambiente de execução',
    'Autor',
    'Licença',
    'Gestão do ambiente de execução',
    'O Teloa gere as definições de negócio e as respetivas associações; o DSH gere competências nativas, ligações MCP e ambientes de execução.',
    'Ligações e ambiente de execução',
    'Lista de recursos original e validação',
    'Ver conteúdo original e versões',
    'Exportar lista de recursos',
    'Voltar ao marketplace',
    'Plano de utilização de capacidades v',
    'Conteúdo de uma competência',
    'Conteúdo da competência',
  ],
} as const

test('十套主语言与两个地区 locale 使用唯一且确定的产品身份', () => {
  assert.deepEqual(MAIN_LOCALES, ['zh-CN', 'zh-Hant', 'en', 'ja', 'ko', 'vi', 'es', 'fr', 'de', 'pt'])
  assert.deepEqual(REGION_LOCALES, ['zh-TW', 'zh-HK'])
  assert.equal(resolveProductLocale('zh'), 'zh-CN')
  assert.equal(resolveProductLocale('zh-CN'), 'zh-CN')
  assert.equal(resolveProductLocale('zh-Hant'), 'zh-Hant')
  assert.equal(resolveProductLocale('zh-TW'), 'zh-TW')
  assert.equal(resolveProductLocale('zh-HK'), 'zh-HK')
  assert.equal(resolveProductLocale('zh-MO'), 'zh-HK')
  assert.equal(resolveProductLocale('zh-Hant-MO'), 'zh-HK')
  assert.equal(resolveProductLocale('de-DE'), 'de')
  assert.equal(resolveProductLocale('pt-BR'), 'pt')
  assert.equal(resolveProductLocale('not a locale'), 'en')
})

test('地区中文只回退人工繁中，DSH zh 归一到简中', () => {
  assert.deepEqual(fallbackChain('zh-TW'), ['zh-TW', 'zh-Hant', 'en'])
  assert.deepEqual(fallbackChain('zh-HK'), ['zh-HK', 'zh-Hant', 'en'])
  assert.deepEqual(fallbackChain('zh-MO'), ['zh-HK', 'zh-Hant', 'en'])
  assert.deepEqual(fallbackChain('zh'), ['zh-CN', 'en'])
  assert.deepEqual(fallbackChain('ja-JP'), ['ja', 'en'])
  assert.deepEqual(fallbackChain('invalid locale'), ['en'])
  assert.equal(translateMessage('zh-TW', 'shell.settings' as never), '設定')
  assert.equal(translateMessage('zh-HK', 'shell.workspace.mine'), '我的工作區')
  assert.equal(translateMessage('zh-TW', 'navigation.attention'), '需要你')
  assert.notEqual(translateMessage('zh-TW', 'shell.taskTemplate.save'), catalogs['zh-CN']['shell.taskTemplate.save'])
})

test('市场模板治理入口使用当地文案，非中文词典不混入汉字', () => {
  for (const locale of Object.keys(localizedMarketTemplateValues) as Array<keyof typeof localizedMarketTemplateValues>) {
    assert.deepEqual(
      localizedMarketTemplateKeys.map(key => translateMessage(locale, key)),
      localizedMarketTemplateValues[locale],
      locale,
    )
  }

  for (const locale of ['en', 'ko', 'vi', 'es', 'fr', 'de', 'pt'] as const) {
    for (const key of localizedMarketTemplateKeys) {
      assert.doesNotMatch(translateMessage(locale, key), /\p{Script=Han}/u, `${locale}:${key}`)
    }
  }
})

test('十套主词典完整且没有空词条，地区覆写只使用合法 key', () => {
  assert.deepEqual([...MESSAGE_KEYS].sort(), expectedKeys)
  validateCatalogs(catalogs, regionCatalogs)
  for (const locale of MAIN_LOCALES) {
    assert.deepEqual(Object.keys(catalogs[locale]).sort(), expectedKeys, locale)
    for (const key of MESSAGE_KEYS) {
      const value = translateMessage(locale, key)
      assert.ok(value.trim(), `${locale}:${key}`)
      assert.notEqual(value, key, `${locale}:${key}`)
    }
  }
  for (const locale of REGION_LOCALES) {
    assert.ok(Object.keys(regionCatalogs[locale]).length > 0, locale)
    assert.ok(Object.keys(regionCatalogs[locale]).every(key => expectedKeys.includes(key as typeof MESSAGE_KEYS[number])), locale)
  }
})

test('第一批核心页面词条在十套主语言中提供人工翻译与变量插值', () => {
  const homeTitles = {
    'zh-CN': '今天，一起完成什么？',
    'zh-Hant': '今天，一起完成什麼？',
    en: 'What shall we accomplish today?',
    ja: '今日は何を一緒に進めますか？',
    ko: '오늘은 무엇을 함께 해낼까요?',
    vi: 'Hôm nay chúng ta sẽ cùng hoàn thành việc gì?',
    es: '¿Qué vamos a lograr hoy?',
    fr: 'Qu’allons-nous accomplir aujourd’hui ?',
    de: 'Was wollen wir heute gemeinsam schaffen?',
    pt: 'O que vamos realizar hoje?',
  } as const
  for (const locale of MAIN_LOCALES) {
    assert.equal(translateMessage(locale, 'home.title' as never), homeTitles[locale])
  }

  assert.equal(translateMessage('zh-Hant', 'navigation.newConversation' as never), '新增工作對話')
  assert.equal(translateMessage('ja', 'team.empty.unconfigured' as never), "まだ従業員が設定されていません")
  assert.equal(translateMessage('ko', 'task.detail.goal' as never), '작업 목표')
  assert.equal(translateMessage('vi', 'continuous.tab.runs' as never), 'Lịch sử chạy')
  assert.equal(translateMessage('es', 'settings.document.open' as never), 'Abrir documento')
  assert.equal(translateMessage('fr', 'profile.title' as never), 'Profil personnel')
  assert.equal(translateMessage('de', 'about.tagline' as never), 'Ein eigenes KI-Team. Für alle.')
  assert.equal(translateMessage('pt', 'home.attentionCount' as never, {count: 3}), '3 trabalhos precisam de você')
})

test('一级导航、创建入口和状态使用当地产品常用短语',()=>{
  const expected={
    'zh-CN':['需要你','资料','能力','新建工作会话','添加 AI 员工','新建协作群','依据已过时'],
    'zh-Hant':['需要你','資料','能力','新增工作對話','新增 AI 員工','新增群組','依據已過時'],
    en:['Needs your attention','Library','Capabilities','New work session',"Add AI employee",'New group','Evidence out of date'],
    ja:['確認が必要','ライブラリ','ケイパビリティ','新しい作業会話',"AI 従業員を追加",'新しいグループ','根拠が古くなっています'],
    ko:['확인 필요','라이브러리','역량','새 작업 대화',"AI 직원 추가",'새 그룹','근거가 오래됨'],
    vi:['Cần bạn xử lý','Thư viện','Năng lực','Phiên làm việc mới',"Thêm nhân viên AI",'Nhóm mới','Bằng chứng đã cũ'],
    es:['Requiere tu atención','Biblioteca','Capacidades','Nueva sesión de trabajo',"Añadir empleado de IA",'Nuevo grupo','Evidencia desactualizada'],
    fr:['À traiter','Bibliothèque','Capacités','Nouvelle session de travail',"Ajouter un employé IA",'Nouveau groupe','Preuve obsolète'],
    de:['Zu erledigen','Bibliothek','Leistungen','Neue Arbeitssitzung',"KI-Mitarbeiter hinzufügen",'Neue Gruppe','Nachweis veraltet'],
    pt:['Requer atenção','Biblioteca','Capacidades','Nova sessão de trabalho',"Adicionar funcionário de IA",'Novo grupo','Evidência desatualizada'],
  } as const
  const keys=['navigation.attention','navigation.resources','navigation.capabilities','navigation.newConversation','team.action.new','home.action.newGroup','status.stale'] as const
  for(const locale of MAIN_LOCALES)assert.deepEqual(keys.map(key=>translateMessage(locale,key)),expected[locale],locale)
  assert.equal(translateMessage('zh-Hant','shell.settings'),'設定')
  assert.equal(translateMessage('ko','status.completed'),'완료')
  assert.equal(translateMessage('ko','status.paused'),'일시 중지')
  assert.equal(translateMessage('ko','status.archived'),'보관')
  assert.equal(translateMessage('pt','status.failed'),'Falha')
  assert.equal(translateMessage('en','common.allBusiness'),'All business areas')
  assert.equal(translateMessage('es','common.allBusiness'),'Todas las áreas')
  assert.equal(translateMessage('pt','common.allBusiness'),'Todas as áreas')
  assert.equal(translateMessage('en','team.empty.reset'),'Reset filters')
  assert.equal(translateMessage('fr','team.empty.reset'),'Réinitialiser les filtres')
})

test('英文待处理入口及关联说明统一使用 Needs your attention',()=>{
  assert.equal(translateMessage('en','navigation.attention'),'Needs your attention')
  assert.equal(translateMessage('en','task.table.attention'),'Needs your attention')
  assert.equal(translateMessage('en','capability.attention.back'),'Back to Needs your attention')
  assert.match(translateMessage('en','business.analysis.noRole'),/Needs your attention/)
})

test('持续执行目录按当地语言表达执行记录',()=>{
  const expected={
    'zh-CN':'执行记录','zh-Hant':'執行記錄',en:'Run history',ja:'実行履歴',ko:'실행 내역',
    vi:'Lịch sử chạy',es:'Historial de ejecuciones',fr:'Historique des exécutions',de:'Ausführungsverlauf',pt:'Histórico de execuções',
  } as const
  for(const locale of MAIN_LOCALES)assert.equal(translateMessage(locale,'continuous.tab.runs'),expected[locale],locale)
})

test('自动化说明区分本次执行任务与后续跟进任务',()=>{
  assert.match(translateMessage('zh-CN','continuous.v2.description'),/每次执行会创建任务/)
  assert.match(translateMessage('zh-CN','continuous.v2.description'),/跟进任务/)
  assert.equal(translateMessage('zh-CN','plan.execution.task',{state:'执行中'}),'本次任务：执行中')
  assert.equal(translateMessage('zh-CN','plan.execution.openTask'),'打开本次任务')
  assert.equal(translateMessage('en','plan.execution.task',{state:'Running'}),'Execution task: Running')
  assert.equal(translateMessage('en','plan.execution.openTask'),'Open execution task')
})

test('沙盒与 AI-Native Team Studio 说明保留产品概念',()=>{
  const sandbox={vi:'Kế hoạch sandbox mới',es:'Nuevo plan sandbox',fr:'Nouveau plan sandbox',de:'Neuer Sandbox-Plan',pt:'Novo plano sandbox'} as const
  for(const locale of Object.keys(sandbox) as (keyof typeof sandbox)[])assert.equal(translateMessage(locale,'continuous.action.createSandbox'),sandbox[locale])
  for(const locale of MAIN_LOCALES)assert.equal(translateMessage(locale,'about.studio'),'AI-Native Team Studio',locale)
  assert.equal(translateMessage('en','app.name'),'Teloa AI-Native Team Studio')
  assert.equal(translateMessage('pt','continuous.sandbox.title'),'Sandbox de automação')
  assert.equal(translateMessage('pt','about.rewardCaption'),'Leia o código para apoiar via PayPal')
  assert.equal(translateMessage('en','about.connections'),'Contact and support')
  assert.equal(translateMessage('en','about.foundationDescription'),'Teloa is built on DeepSeek Harness (DSH). Thanks to the open-source community and contributors behind it.')
})

test('运行时校验拒绝空词条、主词典缺键和非法地区 key', () => {
  assert.throws(
    () => validateCatalogs({...catalogs, en: {...catalogs.en, 'shell.workspace.mine': '   '}} as typeof catalogs, regionCatalogs),
    /empty|空/i,
  )
  const incomplete = {...catalogs.en} as Record<string, string>
  delete incomplete['shell.workspace.mine']
  assert.throws(
    () => validateCatalogs({...catalogs, en: incomplete} as typeof catalogs, regionCatalogs),
    /missing|缺少/i,
  )
  assert.throws(
    () => validateCatalogs(catalogs, {...regionCatalogs, 'zh-TW': {...regionCatalogs['zh-TW'], surprise: '意外'}} as typeof regionCatalogs),
    /unknown|未知/i,
  )
  assert.throws(
    () => validateCatalogs({...catalogs, it: catalogs.en}, regionCatalogs),
    /unknown|未知/i,
  )
  assert.throws(
    () => validateCatalogs(catalogs, {...regionCatalogs, 'zh-SG': {}}),
    /unknown|未知/i,
  )
})

test('回退图拒绝未知目标、空词条式节点和循环', () => {
  assert.doesNotThrow(() => validateFallbackGraph({en: null, fr: 'en', 'fr-CA': 'fr'}))
  assert.throws(() => validateFallbackGraph({en: null, fr: 'missing'}), /unknown|未知/i)
  assert.throws(() => validateFallbackGraph({en: null, fr: 'fr-CA', 'fr-CA': 'fr'}), /cycle|循环/i)
  assert.throws(() => validateFallbackGraph({en: null, '': 'en'}), /empty|空/i)
})

test('Auto Dream 与群提及新增词条在十套主语言齐全，禁系统词', () => {
  const autoDreamZhCn = {
    "dailyLog.switchTitle": "开启 Auto Dream",
    "dailyLog.triggerTitle": "生成时刻",
    "dailyLog.triggerHint": "每天这个时刻生成，保存后按新时刻安排下一次生成。",
    "autoDream.recent.title": "最近 7 天",
    "autoDream.recent.unavailable": "读取失败，状态未知",
    "autoDream.recent.refresh": "刷新",
    "autoDream.recent.generated": "今天已生成",
    "autoDream.recent.noEvidence": "今天没有可核对的证据",
    "autoDream.recent.habitGenerated": "习惯观察 · 今天已生成",
    "autoDream.recent.empty": "还没有在岗的员工或分身。",
    "autoDream.missingPlan": "有 {count} 位升级前已在岗的员工还没有 Auto Dream 计划。",
    "autoDream.missingPlanAction": "为 TA 补建",
    "autoDream.missingPlanHint": "到这位员工的主页暂停再复岗一次即可补建。",
    "dailyLog.recentCount": "最近 60 天 · {count} 份",
    "dailyLog.today": "今天 · {date}",
    "dailyLog.evidenceCount": "当日证据 · {count}",
    "dailyLog.candidateCount": "相关记忆 · {count} 条",
    "dailyLog.pruneHintsCount": "建议撤回 · {count} 条",
    "dailyLog.more": "更多操作",
    "dailyLog.recover": "核对未完成请求",
    "habitLog.promoteFold": "补充观察（还可添加 {count} 条）",
    "dailyLog.emptyTitle": "还没有工作日志",
    "habitLog.emptyTitle": "还没有习惯观察",
    "dailyLog.emptyNext": "下次生成时刻：{time}（{timezone}）",
    'dailyLog.timeHint': '每天这个时刻生成，默认 23:30（新加坡时间）。',
    'autoDream.name': 'Auto Dream',
    'dailyLog.title': 'Auto Dream · 每日小结',
    'dailyLog.entry': '工作日志',
    'dailyLog.empty': '今天没有可核对的工作证据，未生成小结。',
    'dailyLog.evidence': '当日证据',
    'dailyLog.candidates': '相关记忆',
    'dailyLog.candidateHint': 'Auto Dream 自动保存记忆，你可以查看来源或撤回不再适用的内容。',
    'dailyLog.pruneHints': '建议撤回',
    'dailyLog.pruneHintHint': '与今天的证据不一致，要不要撤回？不点就继续生效。',
    'dailyLog.pruneStale': '这条建议已失效。',
    'dailyLog.discard': '丢弃这份日志',
    'dailyLog.switch': 'Auto Dream',
    'dailyLog.switchHint': "关掉后员工不再生成每日小结、分身不再生成习惯观察；已有的日志保留。",
    'habitLog.title': 'Auto Dream · 习惯观察',
    'habitLog.hint': '只看你自己的操作：放行与拒绝、对成果的修订、交办的写法、群里的纠正。',
    'habitLog.promote': '补充观察',
    'habitLog.promoteLimit': '一份观察最多记下 3 条。',
    'habitLog.private': '只有你能看到',
    'habitLog.discard': '丢弃这份观察',
    'roleMemory.privateLimit': '分身私有记忆最多确认 30 条；请先撤回不再适用的记忆。',
    'roleMemory.sourceDaily': '来自 Auto Dream 每日小结',
    'roleMemory.sourceHabit': '来自 Auto Dream 习惯观察',
    'roleMemory.sourceGone': '来源已不可回看。',
  } as const
  const groupMentionZhCn = {
    'group.mention.pick': '提及员工',
    'group.mention.limit': "一条消息最多提及 8 位员工。",
    'group.mention.notMember': "该员工不在本群，无法提及。",
    'group.mention.formOpened': '已为你打开建任务表单，负责人已填好。',
    'group.mention.readyOnly': '提及只会新建待办任务，不会自动开始、完成或审批。',
    'group.mention.all': '提及全员',
    'group.mention.allNotice': "已通知全员，员工会各自回应。",
    'group.grant.canAutoRun': '允许本群自动开始运行',
    'group.grant.canAutoRunHint': "关掉时，提及这位员工只会新建待办任务。",
  } as const
  const newKeys = [...Object.keys(autoDreamZhCn), ...Object.keys(groupMentionZhCn)] as Array<typeof MESSAGE_KEYS[number]>
  assert.equal(newKeys.length, 57)
  // 按语言分派禁词表：只对本次两份新词表 37 键做该断言，不卷入全仓既有词表。
  // （原先此处记的例外「连接人类与 AI 员工」已在终审回写里改为「连接人与 AI 同事」，
  //   全仓既有词表当前已无「人类」；把断言扩到全表是另一件事，本轮不做。）
  const forbiddenByLocale: Record<typeof MAIN_LOCALES[number], RegExp> = {
    'zh-CN': /工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/,
    'zh-Hant': /工作空間|單空間|實例|投影|尚未載入|內容待讀取|\d+\s*項資源|人類/,
    en: /workspace|instance|\bhumans?\b/i,
    ja: /ワークスペース|インスタンス|人間/,
    ko: /워크스페이스|인스턴스|인간/,
    vi: /workspace|instance|con người/i,
    es: /workspace|instance|humanos?/i,
    fr: /workspace|instance|humains?/i,
    de: /workspace|instance|Mensch(?:en)?/i,
    pt: /workspace|instance|humanos?/i,
  }
  for (const key of newKeys) {
    assert.ok(expectedKeys.includes(key), `missing key: ${key}`)
  }
  for (const [key, value] of Object.entries({...autoDreamZhCn, ...groupMentionZhCn})) {
    assert.equal(translateMessage('zh-CN', key as never), value, key)
  }
  for (const key of newKeys) {
    for (const locale of MAIN_LOCALES) {
      const value = translateMessage(locale, key)
      assert.ok(value.trim().length > 0, `${locale}:${key}`)
      assert.notEqual(value, key, `${locale}:${key}`)
      assert.doesNotMatch(value, forbiddenByLocale[locale], `${locale}:${key}`)
    }
  }
})

test('市场 role / model 新词条：每键 11 列、10 语言非空、zh-CN 与 en 无禁词',()=>{
 const keys=['market.catalog.official.roleBadge','market.catalog.official.addRole','market.catalog.official.roleCreated','market.catalog.official.roleExisting','market.catalog.official.roleSkills','market.catalog.official.roleSkillsHint','market.catalog.official.roleFromSolution','market.catalog.official.modelBadge','market.catalog.official.modelConfigure','market.catalog.official.modelReachDirect','market.catalog.official.modelReachMirror','market.catalog.official.modelReachProxy','market.catalog.official.modelPriceLow','market.catalog.official.modelPriceMid','market.catalog.official.modelPriceHigh','market.catalog.official.modelPriceVaries','market.catalog.official.modelRestricted','market.catalog.official.modelExperimental','market.catalog.official.newerApp'] as const
 const params={count:3,skills:'a',packageId:'p',version:'1.0.0',name:'x'}
 for(const key of keys){
  for(const locale of MAIN_LOCALES){const value=translateMessage(locale,key as never,params);assert.ok(value&&!value.startsWith('market.')&&!/\{\w+\}/.test(value),`${locale} ${key}`)}
  assert.doesNotMatch(translateMessage('zh-CN',key as never,params),/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/)
  assert.doesNotMatch(translateMessage('en',key as never,params),/workspace|instance|\bhumans?\b/i)
 }
 assert.equal(translateMessage('zh-CN','market.catalog.official.newerApp' as never,{count:3}),'有 3 项需更新应用后可用')
 assert.equal(translateMessage('zh-CN','market.catalog.official.roleFromSolution' as never,{packageId:'soc-operations',version:'1.0.0'}),'来自方案 soc-operations@1.0.0')
})

// 白话守卫：全量十语词条不再出现工程术语。禁词表与豁免表（带理由）共用 tests/plain-language-jargon.mjs，
// 宿主确认卡、市场站 copy() 文案由 tests/plain-language-copy.test.mjs 用同一张表扫描。只扫描词条文本，不扫键名等机器标识。
test('面向用户的十语词条使用白话，不出现工件、快照、钉版、上游、回执、实例等工程术语', () => {
  const hits:string[]=[]
  for (const locale of MAIN_LOCALES) {
    for (const key of MESSAGE_KEYS) {
      if (Object.hasOwn(plainLanguageExemptions, key)) continue
      const value = translateMessage(locale, key)
      if (plainLanguageJargon[locale].test(value)) hits.push(`${locale}:${key}: ${value}`)
    }
  }
  assert.deepEqual(hits, [])
  // 豁免只放界面位置义：豁免键的中文不能出现版本锁定义的搭配；每条豁免都要写理由。
  for (const [key, reason] of Object.entries(plainLanguageExemptions)) {
    assert.ok(MESSAGE_KEYS.includes(key as typeof MESSAGE_KEYS[number]), `豁免键不存在：${key}`)
    assert.ok(reason.trim().length >= 6, `豁免缺理由：${key}`)
    assert.doesNotMatch(translateMessage('zh-CN', key as never), /版本|内容|来源|快照/, key)
  }
  // 守卫本身必须能拦住被替换掉的旧词，且不误伤日常说法。
  for (const [locale, sample] of [['zh-CN','工件随发行固定'],['zh-CN','效果回执'],['zh-CN','资源实例'],['zh-CN','上游来源'],['zh-CN','固定版本'],['zh-CN','未声明许可证'],['zh-Hant','執行個體'],['en','Pinned snapshot'],['en','upstream artifact'],['en','Raw manifest'],['en','Declared skills'],['en','Effect receipt'],['ja','スナップショット'],['ko','고정 스냅숏'],['vi','bản chụp phê duyệt'],['de','Instanz'],['de','Genehmigungsschnappschüsse'],['fr','manifeste'],['zh-CN','当前 Teloa 宿主'],['zh-CN','凭据存储'],['zh-CN','推理运行时'],['zh-CN','多 Harness 引擎'],['zh-CN','随应用发行'],['zh-CN','内容摘要不一致'],['zh-Hant','憑證儲存'],['en','Current Teloa host'],['en','Credential storage'],['en','Catalog digest'],['ja','認証情報'],['ko','자격 증명'],['de','Zugangsdaten'],['es','anfitrión'],['fr','hôte Teloa'],['en','Runtime configuration'],['ja','ランタイム構成'],['ko','런타임 구성'],['de','Laufzeitumgebung'],['zh-Hant','憑證儲存'],['zh-CN','新建AI 同事'],['zh-CN','负责岗位'],['zh-CN','登记插件'],['zh-CN','连接器'],['zh-CN','自动计划'],['zh-CN','已安装 Skill'],['zh-Hant','數位員工'],['zh-Hant','外掛程式'],['zh-Hant','崗位狀態'],['en','Digital employee'],['en','All teammates'],['en','Install plugin'],['en','Recommended connector'],['ja','プラグイン'],['ja','インストール済み Skill'],['ko','디지털 직원'],['ko','플러그인'],['vi','Skill đã cài đặt'],['es','Empleado digital'],['es','Conector MCP'],['fr','Employé numérique'],['fr','connecteur'],['de','Teammitglied'],['de','Plugin-Installation'],['de','Konnektor'],['pt','Funcionário digital'],['pt','Conector'],['en','Role memory'],['en',"the role's duties"]] as const) {
    assert.match(sample, plainLanguageJargon[locale], `${locale}:${sample}`)
  }
  for (const [locale, sample] of [['zh-CN','返回执行记录'],['zh-CN','固定资产折旧'],['zh-CN','固定时间提醒'],['zh-CN','隐私声明'],['zh-CN','社区版预览声明'],['en','Payment receipt'],['en','Download your receipt'],['zh-CN','来源未提供摘要。'],['zh-CN','Teloa 基于 DeepSeek Harness（DSH）构建'],['en','http(s)://host[:port]'],['en','Mirror {host}'],['en','run teloa credentials --action reset'],['en','Auto Dream · Daily digest'],['ja','http(s)://ホスト[:ポート]'],['es','Credencial'],['zh-CN','运行时间 3 分钟'],['zh-CN','版本和摘要'],['zh-Hant','來源憑證驗證失敗'],['en','Run configuration: {runtime}'],['zh-CN','通用岗位'],['zh-CN','起个名字、选个岗位、定好边界'],['zh-CN','岗位使命'],['zh-CN','包含 SKILL.md 的技能目录'],['en','Required skills: {skills}'],['vi','Ví dụ skills/.curated/pdf; thư mục phải có SKILL.md'],['es','{skill} (llama a {origins})'],['de','Skill importieren'],['en','Install count from skills.sh'],['zh-CN','岗位职责说明书'],['zh-CN','连接器件'],['en',"Responsible employee: {role}"]] as const) {
    assert.doesNotMatch(sample, plainLanguageJargon[locale], `${locale}:${sample}`)
  }
})

test('英文为锁定（lock）义的词条，其他语种不能误译成「修正 / 更正」', () => {
  const hits:string[]=[]
  for (const key of MESSAGE_KEYS) {
    if (!lockSense.test(translateMessage('en', key))) continue
    for (const locale of ['ja','ko','vi','es','fr','de','pt'] as const) {
      const value = translateMessage(locale, key)
      if (correctionMistranslation[locale].test(value)) hits.push(`${locale}:${key}: ${value}`)
    }
  }
  assert.deepEqual(hits, [])
  assert.match('データのバージョンが修正されます', correctionMistranslation.ja)
  assert.match('sera corrigée', correctionMistranslation.fr)
})

test('预览如实新增六条词条：11 列、10 语言非空且带占位替换、各语言无禁词、英文列无中日韩字符',()=>{
 const keys=['business.custom.invalidDraft','business.custom.invalidRequest','business.custom.preview.connectionMissing','business.custom.preview.sourceMissing','business.custom.preview.pullFailed','business.custom.preview.configUnreadable'] as const
 const forbiddenByLocale:Record<typeof MAIN_LOCALES[number],RegExp>={
  'zh-CN':/工作空间|单空间|实例|投影|尚未加载|内容待读取|\d+\s*项资源|人类/,'zh-Hant':/工作空間|單空間|實例|投影|尚未載入|內容待讀取|\d+\s*項資源|人類/,
  en:/workspace|instance|\bhumans?\b/i,ja:/ワークスペース|インスタンス|人間/,ko:/워크스페이스|인스턴스|인간/,vi:/workspace|instance|con người/i,
  es:/workspace|instance|humanos?/i,fr:/workspace|instance|humains?/i,de:/workspace|instance|Mensch(?:en)?/i,pt:/workspace|instance|humanos?/i,
 }
 const params={reason:'R',server:'S'}
 for(const key of keys){
  for(const locale of MAIN_LOCALES){
   const value=translateMessage(locale,key as never,params)
   assert.ok(value.trim()&&value!==key&&!/\{\w+\}/.test(value),`${locale} ${key}`)
   assert.doesNotMatch(value,forbiddenByLocale[locale],`${locale} ${key}`)
  }
  assert.doesNotMatch(translateMessage('en',key as never,params),/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/,'英文列不得含中日韩字符：'+key)
 }
 assert.equal(translateMessage('zh-CN','business.custom.invalidDraft' as never,{reason:'字段不在'}),'草案与当前业务配置不兼容，请在对话中修改草案：字段不在')
 assert.equal(translateMessage('zh-CN','business.custom.preview.connectionMissing' as never,{server:'soc'}),'连接 soc 尚未建立。请先在「连接」中完成配置，再测试读取。')
 assert.equal(translateMessage('zh-CN','business.custom.invalidRequest' as never,{reason:'缺少回执'}),'这次操作没有通过检查：缺少回执')
 assert.equal(translateMessage('zh-CN','business.custom.preview.configUnreadable' as never),'数据源配置文件无法读取，请检查配置文件后再预览。')
})

test('二次开发资源与资源问题反馈词条（规格 §7.1）：11 列、10 语言非空且占位替换、英文列无中日韩字符、中英取规格原文',()=>{
 const types=['security','fixed','removed','adapted','added','improved','localized'] as const
 const keys=['market.catalog.official.derivedFrom','market.catalog.official.matchesOriginal','market.catalog.official.originInstalls','market.catalog.official.installsSource','market.catalog.official.installsSourcePlugin','market.catalog.official.reportProblem','market.catalog.derivative.title','market.catalog.derivative.group','market.catalog.derivative.reason','market.catalog.derivative.viewOriginal','market.catalog.derivative.newFile','market.catalog.derivative.unchangedOne','market.catalog.derivative.unchangedMany',...types.map(type=>'market.catalog.derivative.type.'+type),'feedback.resource']
 const params={author:'OpenAI',owner:'openai',repo:'skills',license:'Apache-2.0',count:3,site:'skills.sh',date:'2026-09-20',type:'X',reason:'R',title:'T',id:'openai.x',version:'1.0.0'}
 for(const key of keys){
  assert.ok(MESSAGE_KEYS.includes(key as never),key)
  for(const locale of MAIN_LOCALES){
   const value=translateMessage(locale,key as never,params)
   assert.ok(value.trim()&&value!==key&&!/\{\w+\}/.test(value),`${locale} ${key}`)
  }
  assert.doesNotMatch(translateMessage('en',key as never,params),/[぀-ヿ㐀-鿿가-힯]/,'英文列不得含中日韩字符：'+key)
 }
 const zh=(key:string,values:Record<string,string|number>={})=>translateMessage('zh-CN',key as never,values)
 const en=(key:string,values:Record<string,string|number>={})=>translateMessage('en',key as never,values)
 assert.equal(zh('market.catalog.official.matchesOriginal'),'与原版一致（锁定版本，已校验）')
 assert.equal(en('market.catalog.official.matchesOriginal'),'Matches the original (locked version, verified)')
 assert.equal(zh('market.catalog.official.derivedFrom',{author:'OpenAI',owner:'openai',repo:'skills',license:'MIT'}),'二次开发自 OpenAI（openai/skills） · 许可 MIT')
 assert.equal(en('market.catalog.official.derivedFrom',{author:'OpenAI',owner:'openai',repo:'skills',license:'MIT'}),'Derived from OpenAI (openai/skills) · License MIT')
 assert.equal(zh('market.catalog.derivative.title',{count:5}),'修改清单（5 项）');assert.equal(en('market.catalog.derivative.title',{count:5}),'Change list (5)')
 assert.deepEqual(types.map(type=>zh('market.catalog.derivative.type.'+type)),['安全修复','修复','移除','适配','新增','优化','本地化'])
 assert.deepEqual(types.map(type=>en('market.catalog.derivative.type.'+type)),['Security fix','Fix','Removed','Adapted','Added','Improved','Localized'])
 assert.equal(zh('market.catalog.derivative.reason',{reason:'R'}),'原因：R');assert.equal(en('market.catalog.derivative.reason',{reason:'R'}),'Why: R')
 assert.equal(zh('market.catalog.derivative.viewOriginal'),'查看原版');assert.equal(en('market.catalog.derivative.viewOriginal'),'View original')
 assert.equal(zh('market.catalog.derivative.newFile'),'原版没有这个文件');assert.equal(en('market.catalog.derivative.newFile'),'Not in the original')
 assert.equal(zh('market.catalog.derivative.unchangedMany',{count:3}),'其余 3 个文件与原版一致（已校验）');assert.equal(en('market.catalog.derivative.unchangedMany',{count:3}),'The other 3 files match the original (verified)')
 assert.equal(zh('market.catalog.official.installsSource',{site:'skills.sh',date:'2026-09-20'}),'安装量来自 skills.sh，2026-09-20 抓取')
 assert.equal(en('market.catalog.official.installsSource',{site:'skills.sh',date:'2026-09-20'}),'Install count from skills.sh, retrieved 2026-09-20')
 assert.equal(zh('market.catalog.official.installsSourcePlugin',{site:'skills.sh',date:'2026-09-20'}),'安装量来自 skills.sh，2026-09-20 抓取（按所在整包统计）')
 assert.equal(en('market.catalog.official.installsSourcePlugin',{site:'skills.sh',date:'2026-09-20'}),'Install count from skills.sh, retrieved 2026-09-20 (counted for the whole package)')
 assert.equal(zh('market.catalog.official.reportProblem'),'问题反馈');assert.equal(en('market.catalog.official.reportProblem'),'Report a problem')
 assert.equal(zh('feedback.resource',{title:'T',id:'openai.x',version:'1.0.0'}),'反馈的资源：T（openai.x v1.0.0）')
 assert.equal(en('feedback.resource',{title:'T',id:'openai.x',version:'1.0.0'}),'About: T (openai.x v1.0.0)')
})
