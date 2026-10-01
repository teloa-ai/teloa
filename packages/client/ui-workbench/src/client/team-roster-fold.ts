// 值导入必须写 .ts：本文件被测试直接 import，走裸 node --test 而非 Vite，没有 .js→.ts 的解析映射。
import {WORKBENCH_NAVIGATION_MAX_BYTES} from './workbench-navigation-state.ts'

export const ROSTER_FOLD_LIMIT=6
export const ROSTER_FOLD_MAX_CHARS=240
export type RosterFoldState={toggled:readonly string[]}

/**
 * 用一个业务范围标识绝不会出现的字符做分隔符：`business-scopes.ts` 的 `label()` 排除
 * `\x00-\x08`、`\x0b`、`\x0c`、`\x0e-\x1f`、`\x7f`，选其中的 `\x1f`（单元分隔符）
 * 既能保证不与合法范围标识撞车，又不用另外发明一套转义规则。
 */
const ROSTER_FOLD_SEPARATOR='\x1f'
const utf8Bytes=(value:string)=>new TextEncoder().encode(value).byteLength
const validScopeId=(value:string)=>value.length>0&&value.length<=80&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)

/** 三档优先级：搜索中恒展开 > 用户切换过的记忆 > 成员数 ≤6 的默认。 */
export function rosterSectionOpen(input:{sectionId:string;members:number;searching:boolean;focused:boolean;fold:RosterFoldState}):boolean{
 // focused 仅表示尚未消费的跳转聚焦；调用方完成展开后清除此信号，恢复用户折叠记忆。
 if(input.searching||input.focused)return true
 const defaultOpen=input.members<=ROSTER_FOLD_LIMIT
 // 记忆只存「这个分区被手动切换过」，不单独存目标布尔值：可见状态取「跟默认相反」，
 // 默认值本身变了（比如分区人数变化跨过阈值），记忆的含义也跟着自然调整，不需要额外迁移。
 return input.fold.toggled.includes(input.sectionId)?!defaultOpen:defaultOpen
}

/** 切换后的新记忆；最近切换的排在串尾，方便超界时从串头（最旧）丢起。 */
export function rosterFoldToggle(fold:RosterFoldState,sectionId:string):RosterFoldState{
 // 含分隔符的范围标识按 `label()` 的排除规则本不该出现；万一出现，写进串里会让读取时的
 // split 把它拆成两段假记忆，宁可跳过这个分区的折叠记忆，也不能连累其它分区一起读错。
 if(sectionId.includes(ROSTER_FOLD_SEPARATOR))return fold
 const without=fold.toggled.filter(id=>id!==sectionId)
 const wasToggled=without.length!==fold.toggled.length
 return {toggled:wasToggled?without:[...without,sectionId]}
}

/** 读不懂的记忆一律退回空，不做部分保留：不知道是哪次写入截断的，半份记忆比没有记忆更危险。 */
export function readRosterFold(raw:string|undefined):RosterFoldState{
 if(!raw)return {toggled:[]}
 const parts=raw.split(ROSTER_FOLD_SEPARATOR).filter(Boolean)
 if(parts.some(part=>!validScopeId(part)))return {toggled:[]}
 return {toggled:parts}
}

function trimmedToggled(toggled:readonly string[]):string[]{
 let result=[...toggled]
 // 从串头（最旧）丢起，保留串尾（最近切换）的——`rosterFoldToggle` 已经保证最近的排在最后。
 while(result.length&&result.join(ROSTER_FOLD_SEPARATOR).length>ROSTER_FOLD_MAX_CHARS)result=result.slice(1)
 return result
}

/**
 * 超 `WORKBENCH_NAVIGATION_MAX_BYTES` 时整体落空串：`open` 字段和同一份 JSON 里的
 * `status`/`kind` 共享 16KB 总上限，宁可丢折叠记忆，也不能拖累导航恢复整体失败。
 *
 * 这个超界预测只看调用方传入的 `siblings`（今天是 `{status,kind}`）——按简报给定的接口签名，
 * 本函数拿不到同一份 `WorkbenchNavigationState` 里其它目录、`selected`、`detail` 的实际大小，
 * 只能算「这个 category JSON 自己」的字节数，不是整份恢复记录的精确预测。这是近似值，不改接口；
 * `open` 自身仍然受 `ROSTER_FOLD_MAX_CHARS`（240 字）硬上限约束，不依赖这个近似值兜底。
 */
export function writeRosterFold(fold:RosterFoldState,siblings:Readonly<Record<string,string>>):string{
 const candidate=trimmedToggled(fold.toggled).join(ROSTER_FOLD_SEPARATOR)
 if(utf8Bytes(JSON.stringify({...siblings,open:candidate}))>WORKBENCH_NAVIGATION_MAX_BYTES)return ''
 return candidate
}
