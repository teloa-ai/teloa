import type {ContextFormed} from '@deepseek-ai/dsh-llm/message'

/** 与官方 V3→V4 迁移对未知 plugin 身份的映射一致，旧资料上下文可直接继续读取。 */
export const resourceMessageSource='plugin:teloa.resources' as const

declare module '@deepseek-ai/dsh-llm' {
 interface MessageSourceMap {
  'plugin:teloa.resources':{kind:typeof resourceMessageSource}&ContextFormed
 }
}
