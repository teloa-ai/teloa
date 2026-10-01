// 「招一位新同事」的入职三问答不出技术字段：三张岗位卡把契约必填的五组结构化职责 + dataScope/executionScope
// 一次填满，第三问的三段开关再把五类动作逐条翻译成 autonomousActions / confirmationPoints / executionScope 的禁止句
// （规格 §4.6）。写入路径不变——这里只产出 RoleFields 的字段值，真正的写入与校验仍在 RoleForm → persistence.create。
import type { RoleFields, RoleResponsibility } from './role-preview.js'
import type { TeloaTranslate } from './i18n/index.js'

export const HIRE_ACTIONS = ['read', 'think', 'draft', 'change', 'send'] as const
export const HIRE_LEVELS = ['self', 'ask', 'never'] as const
export type HireAction = typeof HIRE_ACTIONS[number]
export type HireLevel = typeof HIRE_LEVELS[number]

// 默认边界照原型 `数字员工形象.jsx:212-218` 的 boundaryActions：查资料/做分析默认自己做，
// 起草/改线上默认先问你，外发默认不能做。
export const HIRE_DEFAULT_LIMITS: Readonly<Record<HireAction, HireLevel>> = {
  read: 'self', think: 'self', draft: 'ask', change: 'ask', send: 'never',
}

export const HIRE_PRESETS = ['general', 'investigate', 'code', 'compliance'] as const
export type HirePreset = typeof HIRE_PRESETS[number]

type PresetKeys = Readonly<{
  name: string
  duty: string
  skills: readonly string[]
  extra: readonly string[]
  dataScope: string
}>
// 通用岗位默认开放职责编辑；专业预设提供起点，不把岗位描述当作已安装的 Skill。
const PRESET_KEYS: Readonly<Record<HirePreset, PresetKeys>> = {
  general: {
    name: 'team.hire.preset.general.name',
    duty: 'team.hire.preset.general.duty',
    skills: ['team.hire.preset.general.skill1', 'team.hire.preset.general.skill2'],
    extra: [],
    dataScope: 'team.form.defaultDataScope',
  },
  investigate: {
    name: 'team.hire.preset.investigate.name',
    duty: 'team.hire.preset.investigate.duty',
    skills: ['team.hire.preset.investigate.skill1', 'team.hire.preset.investigate.skill2', 'team.hire.preset.investigate.skill3'],
    extra: ['team.hire.preset.investigate.extra1', 'team.hire.preset.investigate.extra2'],
    dataScope: 'team.hire.preset.investigate.dataScope',
  },
  code: {
    name: 'team.hire.preset.code.name',
    duty: 'team.hire.preset.code.duty',
    skills: ['team.hire.preset.code.skill1', 'team.hire.preset.code.skill2', 'team.hire.preset.code.skill3'],
    extra: ['team.hire.preset.code.extra1', 'team.hire.preset.code.extra2'],
    dataScope: 'team.hire.preset.code.dataScope',
  },
  compliance: {
    name: 'team.hire.preset.compliance.name',
    duty: 'team.hire.preset.compliance.duty',
    skills: ['team.hire.preset.compliance.skill1', 'team.hire.preset.compliance.skill2', 'team.hire.preset.compliance.skill3'],
    extra: ['team.hire.preset.compliance.extra1', 'team.hire.preset.compliance.extra2'],
    dataScope: 'team.hire.preset.compliance.dataScope',
  },
}

/** 岗位卡的短标题（如「安全调查」），只用于展示，不写入契约字段。 */
export function hirePresetLabel(preset: HirePreset, t: TeloaTranslate): string {
  return t(PRESET_KEYS[preset].name)
}

/** 岗位卡的推荐能力，只用于说明岗位适配度，不是已安装 Skill 的唯一标识。 */
export function hirePresetRecommendedSkills(preset: HirePreset, t: TeloaTranslate): string[] {
  const keys = PRESET_KEYS[preset]
  return [...keys.skills, ...keys.extra].map(key => t(key))
}

/** 推荐能力之外的补充文案，保留给需要单独呈现补充项的界面。 */
export function hirePresetExtraSkills(preset: HirePreset, t: TeloaTranslate): string[] {
  return PRESET_KEYS[preset].extra.map(key => t(key))
}

const emptyResponsibility = () => ({ triggers: [] as string[], autonomousActions: [] as string[], confirmationPoints: [] as string[], escalationRules: [] as string[], deliveryChecks: [] as string[] })

/**
 * 三问答不出技术字段，靠预设一次填满契约必填的五组结构化职责 + dataScope/executionScope。
 * autonomousActions/confirmationPoints 先留空，由 hireApplyLimits 按三段开关逐条填入；
 * triggers/escalationRules/deliveryChecks 用同一套通用默认（照 `演示数据.js:19` roleResponsibility 的默认值），
 * 保证任何预设下这三组都非空。
 *
 * `scopeSummary`（复审 HIGH-1）：规格 §4.6「dataScope 由所选岗位 + 所选业务范围拼出一句固定话」——
 * 传入调用方已经拼好的业务范围一句话摘要，句尾拼一句「只看 <范围> 的资料」；不传或传空串时只有岗位基线句。
 * 这里不接收原始标签数组自己 join：多个范围的列表拼接是语言相关的（中文用顿号，其它语言要用不同的连接词/
 * 分隔符），只有调用方（组件里能拿到 `useI18n().list()`）才知道当前 locale 该怎么拼——复审 LOW：纯函数不该
 * 硬编码一个顿号冒充全部语言的列表格式。
 *
 * `knowledge` 固定给空数组（复审 MEDIUM）：契约的 `knowledge` 存的是资料中心的资源 id，三问答不出真实 id，
 * 塞一句人话描述会让岗位详情页的「它读过的资料」永远显示成「资料缺失」；宁可先空着，入职工牌上提示
 * 「上班后可在资料里补」，比冒充一个假 id 更诚实。
 */
export function hirePresetFields(preset: HirePreset, t: TeloaTranslate, scopeSummary = ''): HireBase {
  const keys = PRESET_KEYS[preset]
  const dataScope = scopeSummary ? `${t(keys.dataScope)} ${t('team.hire.preset.scopeSuffix', { scopes: scopeSummary })}` : t(keys.dataScope)
  return {
    duty: t(keys.duty),
    // Role.skills 保存的是运行时可解析的 Skill 唯一名称。岗位卡上的中文推荐能力
    // 只是面向人的说明，不能冒充 Skill 名称写入，否则会让新岗位在准备执行时失败。
    skills: [],
    knowledge: [],
    responsibility: {
      ...emptyResponsibility(),
      triggers: [t('team.hire.responsibility.trigger')],
      escalationRules: [t('team.hire.responsibility.escalation')],
      deliveryChecks: [t('team.hire.responsibility.delivery')],
    },
    dataScope,
    executionScope: t('team.form.defaultExecutionScope'),
  }
}

const ACTION_LEVEL_KEYS: Readonly<Record<HireAction, Readonly<Record<HireLevel, string>>>> = {
  read: { self: 'team.hire.action.read.self', ask: 'team.hire.action.read.ask', never: 'team.hire.action.read.never' },
  think: { self: 'team.hire.action.think.self', ask: 'team.hire.action.think.ask', never: 'team.hire.action.think.never' },
  draft: { self: 'team.hire.action.draft.self', ask: 'team.hire.action.draft.ask', never: 'team.hire.action.draft.never' },
  change: { self: 'team.hire.action.change.self', ask: 'team.hire.action.change.ask', never: 'team.hire.action.change.never' },
  send: { self: 'team.hire.action.send.self', ask: 'team.hire.action.send.ask', never: 'team.hire.action.send.never' },
}
const ACTION_LABEL_KEYS: Readonly<Record<HireAction, string>> = {
  read: 'team.hire.action.read.label',
  think: 'team.hire.action.think.label',
  draft: 'team.hire.action.draft.label',
  change: 'team.hire.action.change.label',
  send: 'team.hire.action.send.label',
}
const LEVEL_LABEL_KEYS: Readonly<Record<HireLevel, string>> = {
  self: 'team.hire.level.self', ask: 'team.hire.level.ask', never: 'team.hire.level.never',
}

/** 五类动作的短标签（第③屏每行左侧文字，照原型 boundaryActions 的第二列）。 */
export function hireActionLabel(action: HireAction, t: TeloaTranslate): string {
  return t(ACTION_LABEL_KEYS[action])
}

/** 三档开关的按钮文字（自己做 / 问你 / 不能做）。 */
export function hireLevelLabel(level: HireLevel, t: TeloaTranslate): string {
  return t(LEVEL_LABEL_KEYS[level])
}

/**
 * 三段开关 → 契约字段（规格 §4.6 映射表）：选「自己做」追加一条 autonomousActions，
 * 选「问你」追加一条 confirmationPoints，选「不能做」追加一条 executionScope 的禁止句；
 * 五类动作逐项处理，互不覆盖、不进另外两组。
 */
export function hireApplyLimits(base: RoleFields, limits: Readonly<Record<HireAction, HireLevel>>, t: TeloaTranslate): HireAppliedFields {
  const responsibility = base.responsibility ?? emptyResponsibility()
  const autonomousActions = [...responsibility.autonomousActions]
  const confirmationPoints = [...responsibility.confirmationPoints]
  const forbidden: string[] = []
  for (const action of HIRE_ACTIONS) {
    const level = limits[action]
    const sentence = t(ACTION_LEVEL_KEYS[action][level])
    if (level === 'self') autonomousActions.push(sentence)
    else if (level === 'ask') confirmationPoints.push(sentence)
    else forbidden.push(sentence)
  }
  return {
    ...base,
    responsibility: { ...responsibility, autonomousActions, confirmationPoints },
    // 逐句返回，不在这里拼成一行：分隔符是语言相关的写法，由界面层取 team.hire.listJoin 决定。
    executionScope: [base.executionScope, ...forbidden].filter(Boolean),
  }
}

// 与 Pick<RoleFields,...> 故意不同：这里的 responsibility 是必填的（预设基线与自动推导结果永远带着它），
// 避免 exactOptionalPropertyTypes 把「可能是 undefined 的可选字段」和「这里其实永远有值」混在一起。
type HireBase = { duty: string; skills: string[]; knowledge: string[]; responsibility: RoleResponsibility; dataScope: string; executionScope: string }

/** 纯函数层的 executionScope 是逐句数组：谁来渲染谁按语言拼，pure function 里不留中文分号。 */
export type HireAppliedFields = Omit<RoleFields, 'executionScope'> & { executionScope: string[] }
export type HireAutoFields = Omit<HireBase, 'executionScope'> & { executionScope: string[] }

/** 由预设基线 + 当前三段开关，纯函数算出「完全走自动推导」时 6 个字段应该是什么；不读取、不依赖组件状态。 */
export function hireAutoFields(presetBase: HireBase, limits: Readonly<Record<HireAction, HireLevel>>, t: TeloaTranslate): HireAutoFields {
  const applied = hireApplyLimits({ name: '', kind: 'employee', scopes: [], ...presetBase }, limits, t)
  return { duty: applied.duty, skills: applied.skills, knowledge: applied.knowledge, responsibility: applied.responsibility ?? presetBase.responsibility, dataScope: applied.dataScope, executionScope: applied.executionScope }
}

/**
 * 切预设时该怎么合并回 RoleFields：duty/skills/knowledge/dataScope/responsibility/executionScope 整体
 * 重置为新预设 + 当前边界（照原型 `pickJob` 换岗位连技能推荐一起换的行为）。
 */
export function hireMergePreset(current: RoleFields, presetBase: HireBase, limits: Readonly<Record<HireAction, HireLevel>>, t: TeloaTranslate): HireAppliedFields {
  return { ...current, ...hireAutoFields(presetBase, limits, t) }
}

/**
 * 切三段开关时该怎么合并回 RoleFields：只覆盖 responsibility 与 executionScope；
 * duty/skills/knowledge/dataScope 原样保留——复审 HIGH-2：之前整段走 hirePresetFields 重新派生，
 * 会把②屏手动增减过的 skills 静默清空回预设默认值。
 */
export function hireMergeLimit(current: RoleFields, presetBase: HireBase, limits: Readonly<Record<HireAction, HireLevel>>, t: TeloaTranslate): HireAppliedFields {
  const auto = hireAutoFields(presetBase, limits, t)
  return { ...current, responsibility: auto.responsibility, executionScope: auto.executionScope }
}

/**
 * ④屏「展开逐条改」允许手动改 responsibility/dataScope/executionScope；如果用户已经手动改过，
 * 再切预设或三段开关会静默覆盖掉这些手改内容——复审 MEDIUM：先用这个判断要不要提示用户确认。
 * 判据：把 current 的这三块和「如果完全走自动推导现在应该是什么样」比较，不一致就是手动改过。
 */
export function hireDrifted(current: Pick<RoleFields, 'responsibility' | 'dataScope' | 'executionScope'>, presetBase: HireBase, limits: Readonly<Record<HireAction, HireLevel>>, t: TeloaTranslate, listJoin: string): boolean {
  const auto = hireAutoFields(presetBase, limits, t)
  // current 里存的是界面已经拼好的一整行，所以比较前要用调用方同一套分隔符把自动推导结果拼回去。
  return JSON.stringify({ responsibility: current.responsibility, dataScope: current.dataScope, executionScope: current.executionScope })
    !== JSON.stringify({ responsibility: auto.responsibility, dataScope: auto.dataScope, executionScope: auto.executionScope.join(listJoin) })
}
