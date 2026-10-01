// 源自 dsh-im-gateway（https://github.com/zhuiyueya/dsh-im-gateway，commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。
// Teloa 修改：分段前缀「（i/n）」改为可选 opts.prefix（默认关闭）；按码点推进游标（上游按 UTF-16 长度推进会劈开代理对）；段数变化时按真实段数整体重切（上游 rePrefix 截断正文）。许可全文见 packages/im-gateway/licenses/dsh-im-gateway.LICENSE，来源记录见 provenance/dsh-im-gateway.md。
/**
 * 长文本分片：按渠道单条上限切分，优先在换行/中文句号/句点处断行，
 * 分段前缀 `（i/n）` 默认关闭；开启时其字符数参与递归收敛（不会出现「第 3/2 段」）。
 * @module dsh-im-gateway/core/split
 */

export interface SplitOptions {
  /** 是否加分段前缀（默认 false）。 */
  prefix?: boolean
}

/**
 * 计算带前缀的段文本；前缀长度递归收敛进上限。
 */
function withPrefix(index: number, total: number, text: string, max: number): string {
  const prefix = total <= 1 ? '' : `（${index}/${total}）`
  if (prefix.length >= max) return text
  const budget = max - prefix.length
  const body = [...text].slice(0, budget).join('')
  return prefix + body
}

/**
 * 把文本切分为不超过 max 码点的片段序列。
 * 断点优先级：换行 → 中文句号（。！？…）→ 英文句点+空格 → 硬切。
 */
export function splitText(text: string, max: number, opts: SplitOptions = {}): string[] {
  if (max <= 0) return text === '' ? [] : [text]
  const chars = [...text]
  if (chars.length === 0) return []
  if (chars.length <= max) return [text]
  if (opts.prefix !== true) return splitPlain(chars, max)

  // 前缀位数随总段数变化（9→10 段时「（i/n）」多一位），按真实段数重切直到段数不再变化。
  // 初值 ceil(len/max) 是段数下界，段数随 total 单调不减，故只会向上收敛。
  let total = Math.ceil(chars.length / max)
  let parts = splitPrefixed(chars, max, total)
  while (parts.length !== total) {
    total = parts.length
    parts = splitPrefixed(chars, max, total)
  }
  return parts
}

/** 以给定总段数 total 生成带前缀的分段。 */
function splitPrefixed(chars: string[], max: number, total: number): string[] {
  const parts: string[] = []
  let rest = chars
  let index = 1
  while (rest.length > 0) {
    const budget = max - `（${index}/${total}）`.length
    if (budget <= 0) {
      // 前缀本身超限：退化到无前缀硬切
      parts.push(rest.slice(0, max).join(''))
      rest = rest.slice(max)
      index += 1
      continue
    }
    const window = rest.slice(0, budget)
    const cut = findBreak(window)
    const piece = rest.slice(0, cut === 0 ? budget : cut)
    parts.push(withPrefix(index, total, piece.join(''), max))
    rest = rest.slice(piece.length)
    index += 1
  }
  return parts
}

/** 无前缀切分：每片 ≤max 码点，断点规则同上。 */
function splitPlain(chars: string[], max: number): string[] {
  const parts: string[] = []
  let rest = chars
  while (rest.length > 0) {
    const window = rest.slice(0, max)
    const cut = findBreak(window)
    const piece = rest.slice(0, cut === 0 ? max : cut)
    parts.push(piece.join(''))
    rest = rest.slice(piece.length)
  }
  return parts
}

/** 在窗口内找最优断点，返回断点前的长度；0 = 无自然断点。 */
function findBreak(window: string[]): number {
  // 从后往前找换行
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (window[i] === '\n') return i + 1
  }
  // 中文句号/问号/感叹号/省略号
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if ('。！？…；'.includes(window[i] ?? '')) return i + 1
  }
  // 英文句点+空格、逗号+空格
  for (let i = window.length - 2; i >= 0; i -= 1) {
    if (window[i] === '.' && window[i + 1] === ' ') return i + 1
    if (window[i] === ',' && window[i + 1] === ' ') return i + 1
  }
  return 0
}
