const copy = {
  topic: ['本次话题', '本次話題', 'Current topic'],
  main: ['个人主聊', '個人主聊', 'Main chat'],
  brand: ['品牌与版本', '品牌與版本', 'Brand and version'],
  edition: ['产品版本', '產品版本', 'Edition'],
  build: ['构建版本', '建置版本', 'Build'],
  options: ['会话选项', '會話選項', 'Conversation options'],
  greeting: ['今天想完成什么？', '今天想完成甚麼？', 'What would you like to get done today?'],
  welcome: ['描述目标，或继续已有工作。', '描述目標，或繼續現有工作。', 'Describe your goal, or continue existing work.'],
} as const

export function conversationHeaderCopy(locale: string, key: keyof typeof copy): string {
  const normalized = locale.toLowerCase()
  const column = normalized === 'zh' || normalized === 'zh-cn' ? 0 : normalized.startsWith('zh') ? 1 : 2
  return copy[key][column]
}
