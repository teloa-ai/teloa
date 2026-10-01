// 源自 dsh-im-gateway（https://github.com/zhuiyueya/dsh-im-gateway，commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。
// Teloa 修改：仅加出处头，函数体未改。许可全文见 packages/im-gateway/licenses/dsh-im-gateway.LICENSE，来源记录见 provenance/dsh-im-gateway.md。
/**
 * Markdown → 渠道文本的保守转换。
 * - `toPlainText`：去掉围栏/行内代码标记、粗体斜体星号，保留可读结构
 * - `toTelegramHtml`：围栏代码 → <pre>、行内代码 → <code>、粗体 → <b>，
 *   其余 HTML 转义（Telegram HTML 模式）
 * @module dsh-im-gateway/core/format
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 去掉 markdown 标记，保留文本内容。 */
export function toPlainText(markdown: string): string {
  return markdown
    // 围栏代码块：保留内容
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => code.trimEnd())
    // 行内代码
    .replace(/`([^`\n]+)`/g, '$1')
    // 粗体/斜体
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    // 链接 [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    // 标题符、引用符、列表符
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Telegram HTML 模式转换（保守子集；实体非法时调用方回退纯文本）。 */
export function toTelegramHtml(markdown: string): string {
  let out = ''
  const lines = markdown.split('\n')
  let inFence = false
  let fenceBuf: string[] = []
  for (const line of lines) {
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      if (inFence) {
        out += `<pre>${escapeHtml(fenceBuf.join('\n'))}</pre>\n`
        fenceBuf = []
      }
      inFence = !inFence
      continue
    }
    if (inFence) {
      fenceBuf.push(line)
      continue
    }
    out += inlineHtml(line) + '\n'
  }
  if (inFence && fenceBuf.length > 0) {
    out += `<pre>${escapeHtml(fenceBuf.join('\n'))}</pre>\n`
  }
  return out.trim()
}

function inlineHtml(line: string): string {
  let s = escapeHtml(line)
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${code}</code>`)
  // 粗体（先处理 ** 再处理 *）
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
  s = s.replace(/__([^_]+)__/g, '<b>$1</b>')
  s = s.replace(/_([^_\n]+)_/g, '<i>$1</i>')
  // 链接
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
  return s
}
