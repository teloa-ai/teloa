import type {CollaborationScope} from './collaboration-preview.js'
import type {BusinessTarget} from './business-preview.js'

export type BusinessDataMode='real'|'sandbox'

type Input={mode:BusinessDataMode;section:BusinessTarget['section'];scope:CollaborationScope}

/**
 * 业务范围内页采用 B3 对象台账：首屏直接回答「这个业务里有哪些对象、现在是什么处境」。
 * 页面固定走台账（对象类型块）→ 目录（一类对象一张表）→ 详情；任务、自动化、
 * 历史和执行等工作入口属于次级动作，不再与台账并列成主导航。
 *
 * 真实模式的台账与目录都由本范围的声明驱动，台账自己带五档空态（没有声明 / 未连接 / 零对象 /
 * 字段缺失 / 统计截断，规格 §5.4），因此这里不先拿一页快照的读取状态判要不要显示接入引导——
 * 那一页快照只覆盖单一来源，判不了「这个范围有没有声明」。接入引导只留给真实模式下
 * 还没有自己面的其余视图，以及一条声明都没有的空台账（由调用方传进去当空态）。
 */
export function businessPageSurface({mode,section}:Input){
 if(section==='projects')return 'project-workspace'
 if(section==='overview')return mode==='sandbox'?'sandbox-ledger':'real-ledger'
 if(section==='data')return mode==='sandbox'?'sandbox-directory':'real-directory'
 return mode==='sandbox'?'sandbox-section':'real-section'
}

/**
 * 台账和目录之外的视图（历史、项目、持续分析、执行记录）只从范围摘要条右侧的
 * 「更多」进入，进来之后正文整块换成它，并在顶上留一条「回到业务台账」。
 * 从会话、任务详情与右栏页签开过来的深链（`openBusiness(target.section…)`）落在同一条路上，
 * 因此 `BusinessTarget['section']` 枚举原样保留，一处都没删。
 */
export const businessSectionAwayFromLedger=(section:BusinessTarget['section']):boolean=>section!=='overview'&&section!=='data'

/**
 * 带 id 的导航目标在当前形态下有没有落点；没有就整块退回「未找到」。
 *
 * 真实模式的对象目录按 id 自己选中（它读的是本范围声明算出来的台账，不经沙盒台账），
 * 所以带 id 的真实数据目标一定找得到落点——原先一律拿沙盒台账判，
 * 从会话里开过来的真实告警必然当场判成「未找到」，整条入口就废在这一步。
 * 其余视图在真实模式下本来就没有按 id 的详情面，仍按原判据退回。
 */
export function businessTargetMissing({mode,section,id,found}:{mode:BusinessDataMode;section:BusinessTarget['section'];id?:string|undefined;found?:boolean|undefined}):boolean{
 if(section==='projects'||!id)return false
 if(section==='data'&&mode==='real')return false
 return !found
}
