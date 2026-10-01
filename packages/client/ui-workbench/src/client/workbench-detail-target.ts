import type {ArtifactRef,ArtifactSourceRef} from './artifact-preview.js'
import type {BusinessTarget} from './business-preview.js'

/**
 * 会话页与目录页的“第三栏里正开着哪个对象”。
 * 原生右栏是否显示不在这里：右栏现在同时承载官方页类型与 Teloa 的对象页签，
 * 呈现与对象身份是两件互不替代的事，呈现由 store 的 rightbar 切片单独记。
 */
export type WorkbenchDetailTarget=
 |{kind:'directory-object';view:'tasks'|'team'|'spaces'|'resources'|'capabilities'|'market'|'plans';id:string;version?:number;source:{kind:'directory'|'attention'|'search'}}
 |{kind:'conversation-object';sessionId:string;objectKind:'task'|'role';id:string;version?:number}
 |{kind:'conversation-object';sessionId:string;objectKind:'business';target:BusinessTarget}
 |({kind:'artifact';source:ArtifactSourceRef;sessionId?:string}&({artifactId:string;version?:number}|{artifactId?:never;version?:never}))

export type WorkbenchDetailState={open:boolean;target:WorkbenchDetailTarget|null}

export function openDetail(_state:WorkbenchDetailState,target:WorkbenchDetailTarget):WorkbenchDetailState{return {open:true,target}}
export function closeDetail(state:WorkbenchDetailState):WorkbenchDetailState{return state.open?{open:false,target:state.target}:state}

/** 会话来源本身就是绑定；任务、执行、业务来源只有显式 sessionId 才随会话清理。 */
function boundSession(target:WorkbenchDetailTarget):string|undefined{
 if(target.kind==='artifact'&&target.source.kind==='session')return target.source.id
 return 'sessionId' in target?target.sessionId:undefined
}

/** 会话 → 这个会话上一次开着的详情目标。只活在内存里，不随导航记录落盘。 */
export type WorkbenchDetailSeeds=Readonly<Record<string,WorkbenchDetailTarget>>

function dropSeed(seeds:WorkbenchDetailSeeds,session:string):WorkbenchDetailSeeds{
 if(!(session in seeds))return seeds
 const {[session]:_dropped,...rest}=seeds
 return rest
}

/**
 * 切当前会话。真源是原生右栏的页签——页签按会话各留各的，切回去它还在条上，
 * 所以这边的 `state.detail` 也必须能跟着回来：它只是"此刻画什么、刷新恢复什么"的种子。
 * 从前一走了之置空，往返之后页内详情全假：页签正文的"关闭"成了死控件，`objectDetailOpen`
 * 与还摆在右栏里的页签对不上。
 *
 * 不绑会话的详情（目录对象、独立成果）跟着用户走，不进种子本。
 */
export function retainDetailForSession(
 state:WorkbenchDetailState,
 seeds:WorkbenchDetailSeeds,
 sessionId:string|undefined,
):{detail:WorkbenchDetailState;seeds:WorkbenchDetailSeeds}{
 const target=state.target
 const bound=target?boundSession(target):undefined
 // 开着的、不绑会话的详情（目录对象、独立成果）跟着用户走，不进种子本也不被顶掉。
 if(state.open&&target&&bound===undefined)return {detail:state,seeds}
 // 只有还开着的详情才值得记，收起过的要把种子一并销掉：否则往返回来它又自己冒出来。
 const kept=bound===undefined?seeds:state.open?{...seeds,[bound]:target!}:dropSeed(seeds,bound)
 if(bound!==undefined&&bound===sessionId&&state.open)return {detail:state,seeds:kept}
 const seed=sessionId===undefined?undefined:kept[sessionId]
 return {detail:seed?{open:true,target:seed}:{open:false,target:null},seeds:kept}
}

/** 渲染阶段先核对会话，避免清理 effect 执行前短暂展示上一会话的私有详情。 */
export function activeDetailTarget(state:WorkbenchDetailState,sessionId:string|undefined):WorkbenchDetailTarget|null{
 if(!state.open||!state.target)return null
 const bound=boundSession(state.target)
 return bound!==undefined&&bound!==sessionId?null:state.target
}

/**
 * 会话页此刻是否正承载一个会话对象详情（任务 / 岗位 / 空间）。
 *
 * 用处是决定会话页要不要装载任务与岗位台账。原生右栏页签的正文就是整张任务 / 岗位 / 空间页，
 * 它读的是外壳的台账；而台账原先只在工作台 / 数字员工 / 任务 / 需要你四个视图上装载。
 * 刷新之后用户直接落在会话页，页签由 `state.detail` 这颗种子重开，台账却还空着——
 * 页签标题只能退回「任务详情」，正文画出一张「还没有任务」的空目录，
 * 而且会话页此后永远不再装载，用户只有离开会话页再回来才看得到内容。
 *
 * 不新增真源：判据仍是 `state.detail` 这颗既有的种子，与页签各自表达同一件事的两个侧面。
 */
export function conversationLedgerNeeded(view:string,messageMode:string,state:WorkbenchDetailState):boolean{
 return view==='messages'&&messageMode==='native'&&state.open&&state.target?.kind==='conversation-object'
}

export function artifactDetailTarget(source:ArtifactSourceRef,artifact?:ArtifactRef,sessionId?:string):Extract<WorkbenchDetailTarget,{kind:'artifact'}>{
 const target={kind:'artifact' as const,source,...(sessionId?{sessionId}:{})}
 return artifact?{...target,artifactId:artifact.id,version:artifact.version}:target
}

export function artifactPanelTarget(target:WorkbenchDetailTarget|null){
 if(target?.kind!=='artifact')return null
 return {source:target.source,...(target.artifactId?{artifact:{id:target.artifactId,...(target.version!==undefined?{version:target.version}:{})}}:{})}
}
