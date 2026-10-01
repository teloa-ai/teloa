// 同一位同事每次进来形象都一样：只按 id 稳定派生 tone/shape，不落库、不进契约（看 §4.5.3）。
export const STAFF_AVATAR_TONES = 6
export const STAFF_AVATAR_SHAPES = 6

/** 照原型 `数字员工形象.jsx:12` 的 hashOf：初值 7，逐字符 `hash*31+codePoint` 再截成无符号 32 位。 */
function staffAvatarHash(seed: string): number {
  return [...seed].reduce((value, ch) => (value * 31 + (ch.codePointAt(0) ?? 0)) >>> 0, 7)
}

/** 照原型 avatarSeed：hash=Σ(hash*31+codePoint)>>>0，tone=hash%6，shape=(hash>>3)%6。 */
export function staffAvatarSeed(seed: string): { tone: number; shape: number } {
  const hash = staffAvatarHash(seed)
  return { tone: hash % STAFF_AVATAR_TONES, shape: (hash >> 3) % STAFF_AVATAR_SHAPES }
}
