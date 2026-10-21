/** 内置员工头像键；身份定义与可移植模板共享同一白名单。 */
export const ROLE_AVATAR_KEYS = Object.freeze(['ui-designer', 'project', 'researcher', 'sales', 'supporter', 'commerce', 'developer', 'product-manager', 'data-analyst', 'qa-tester', 'it-operations', 'security-analyst', 'marketing', 'content-writer', 'brand-designer', 'hr', 'recruiter', 'finance', 'legal', 'procurement', 'admin', 'executive-assistant', 'business-analyst', 'trainer', 'general', 'general-research', 'general-creative', 'general-execution'])
/** 1.0 小机器人的形状与员工色板；含最新在线稿的墨黑选项；旧预设外观不变。 */
export const ROLE_AVATAR_SHAPES = Object.freeze(['circle', 'pebble', 'star4', 'cloud', 'drop', 'squircle', 'bean', 'flower', 'softtri', 'capsule', 'ghost', 'hexa'])
export const ROLE_AVATAR_COLORS = Object.freeze(['terracotta', 'orange', 'amber', 'olive', 'teal', 'mist', 'indigo', 'plum', 'warmgray', 'ink'])
/**
 * 预设键的固定外观（形状 × 颜色，互不重复）；已保存的旧值据此显示，不能随意改动。
 * 前 12 项沿用 Claude Design 员工对照表，其余按同规则补齐；稿中高管助理与通用同为暖灰圆，高管助理改为梅紫圆。
 */
export const ROLE_AVATAR_PRESETS = Object.freeze({
 'qa-tester': ['squircle', 'amber'], developer: ['hexa', 'indigo'], 'product-manager': ['pebble', 'terracotta'], 'content-writer': ['flower', 'plum'],
 'data-analyst': ['capsule', 'teal'], marketing: ['cloud', 'orange'], researcher: ['bean', 'olive'], supporter: ['drop', 'mist'],
 sales: ['softtri', 'terracotta'], 'ui-designer': ['ghost', 'teal'], 'executive-assistant': ['circle', 'plum'], general: ['circle', 'warmgray'],
 project: ['squircle', 'teal'], commerce: ['capsule', 'orange'], 'it-operations': ['hexa', 'mist'], 'security-analyst': ['hexa', 'olive'],
 'brand-designer': ['flower', 'terracotta'], hr: ['drop', 'plum'], recruiter: ['bean', 'amber'], finance: ['squircle', 'indigo'],
 legal: ['pebble', 'indigo'], procurement: ['capsule', 'amber'], admin: ['circle', 'mist'], 'business-analyst': ['pebble', 'teal'],
 trainer: ['cloud', 'olive'], 'general-research': ['bean', 'mist'], 'general-creative': ['flower', 'orange'], 'general-execution': ['softtri', 'teal']
})
const COMBINATION = /^bot:([a-z0-9]+):([a-z]+)$/
/** 自由组合 `bot:<shape>:<color>` 的形状与颜色；预设键与非法值返回 undefined。 */
function combination(value) {
 const match = typeof value === 'string' ? COMBINATION.exec(value) : null
 return match && ROLE_AVATAR_SHAPES.includes(match[1]) && ROLE_AVATAR_COLORS.includes(match[2]) ? {shape: match[1], color: match[2]} : undefined
}
export const isRoleAvatarCombination = value => combination(value) !== undefined
/** 员工头像取值：28 个预设键，或 0.2.4 起的自由组合。 */
export const isRoleAvatarKey = value => ROLE_AVATAR_KEYS.includes(value) || isRoleAvatarCombination(value)
export function roleAvatarParts(value) {
 if (ROLE_AVATAR_KEYS.includes(value)) { const [shape, color] = ROLE_AVATAR_PRESETS[value]; return {shape, color} }
 return combination(value)
}
/** 选择结果规范化：等于某个预设时返回预设键（旧版本也能读），否则返回组合键。 */
export function roleAvatarKeyOf(shape, color) {
 const preset = ROLE_AVATAR_KEYS.find(key => ROLE_AVATAR_PRESETS[key][0] === shape && ROLE_AVATAR_PRESETS[key][1] === color)
 return preset ?? `bot:${shape}:${color}`
}
