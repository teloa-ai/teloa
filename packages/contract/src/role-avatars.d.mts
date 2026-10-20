export const ROLE_AVATAR_KEYS: readonly ['ui-designer', 'project', 'researcher', 'sales', 'supporter', 'commerce', 'developer', 'product-manager', 'data-analyst', 'qa-tester', 'it-operations', 'security-analyst', 'marketing', 'content-writer', 'brand-designer', 'hr', 'recruiter', 'finance', 'legal', 'procurement', 'admin', 'executive-assistant', 'business-analyst', 'trainer', 'general', 'general-research', 'general-creative', 'general-execution']
export const ROLE_AVATAR_SHAPES: readonly ['circle', 'pebble', 'star4', 'cloud', 'drop', 'squircle', 'bean', 'flower', 'softtri', 'capsule', 'ghost', 'hexa']
export const ROLE_AVATAR_COLORS: readonly ['terracotta', 'orange', 'amber', 'olive', 'teal', 'mist', 'indigo', 'plum', 'warmgray']
export type RoleAvatarPresetKey = typeof ROLE_AVATAR_KEYS[number]
export type RoleAvatarShape = typeof ROLE_AVATAR_SHAPES[number]
export type RoleAvatarColor = typeof ROLE_AVATAR_COLORS[number]
export type RoleAvatarKey = RoleAvatarPresetKey | `bot:${RoleAvatarShape}:${RoleAvatarColor}`
export const ROLE_AVATAR_PRESETS: Readonly<Record<RoleAvatarPresetKey, readonly [RoleAvatarShape, RoleAvatarColor]>>
export function isRoleAvatarKey(value: unknown): value is RoleAvatarKey
export function isRoleAvatarCombination(value: unknown): value is `bot:${RoleAvatarShape}:${RoleAvatarColor}`
export function roleAvatarParts(value: unknown): {shape: RoleAvatarShape; color: RoleAvatarColor} | undefined
export function roleAvatarKeyOf(shape: RoleAvatarShape, color: RoleAvatarColor): RoleAvatarKey
