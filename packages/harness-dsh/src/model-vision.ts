/**
 * 模型视觉能力的三态读法。
 *
 * 能力事实的唯一来源是 `ctx.llm.resolveModelInfo(provider,model)` 回的
 * `LlmResolvedModelInfo.inputModalities`（`@deepseek-ai/dsh-llm` 的 `.d.ts` 逐字写明：
 * 「absent means unknown, while an explicit omission is negative capability」）。
 * 本模块只做纯读，不碰 Cordis、不发请求；调用方自己取到那个值再喂进来。
 */
export type ModelVision='supported'|'unsupported'|'unknown'

/**
 * 三态必须是代码里可区分的三条路：把 unknown 折进 unsupported 会让有视觉的模型也被打成无视觉。
 * 读不到这个值（不是对象、字段缺失、不是数组）一律 `'unknown'`；能力源抛错时调用方按
 * `readModelVision(undefined)` 取同一条路。
 */
export function readModelVision(modelInfo:unknown):ModelVision{
 if(typeof modelInfo!=='object'||modelInfo===null)return 'unknown'
 const modalities=(modelInfo as {inputModalities?:unknown}).inputModalities
 if(!Array.isArray(modalities))return 'unknown'
 return modalities.includes('image')?'supported':'unsupported'
}

/** 调用方的回落口径：只有 `'supported'` 才发图（fail-closed on capability）。 */
export const visionAllowsImages=(value:ModelVision):boolean=>value==='supported'
