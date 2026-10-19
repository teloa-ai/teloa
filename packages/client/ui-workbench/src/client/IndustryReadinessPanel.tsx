// 方案「准备就绪」面板：只展示宿主算好的清单；一键准备走页内二次确认；密钥与授权只给跳转，不在此处填写。
import {useEffect,useRef,useState} from 'react'
import css from './IndustryReadinessPanel.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {IndustryPrepareReceipt,IndustryReadiness,IndustryReadinessRow} from './industry-load-api.js'

export type ReadinessGroupId='models'|'roles'|'knowledge'|'capabilities'|'extensions'|'tasks'|'plans'|'connectors'
export type ReadinessPort={read:(loadId:string)=>Promise<IndustryReadiness>;prepare:(loadId:string,expectedDigest:string)=>Promise<IndustryPrepareReceipt>}
type T=(key:string,params?:Record<string,string|number>)=>string
type Entry=NonNullable<IndustryReadinessRow['entry']>
const entryGroup:Record<Entry,ReadinessGroupId>={'model-settings':'models','connector-settings':'connectors','skill-confirm':'capabilities',plugin:'extensions','knowledge-retry':'knowledge','role-retry':'roles','role-resume':'roles','task-form':'tasks','plan-form':'plans'}
const entryKey={'model-settings':'market.industry.prepare.entry.models','connector-settings':'market.industry.prepare.entry.connector-settings','skill-confirm':'market.industry.prepare.entry.skill-confirm',plugin:'market.industry.prepare.entry.plugin','knowledge-retry':'market.industry.prepare.entry.knowledge-retry','role-retry':'market.industry.prepare.entry.role-retry','role-resume':'market.industry.prepare.entry.role-resume','task-form':'market.industry.prepare.entry.task-form','plan-form':'market.industry.prepare.entry.plan-form'} as const
const stepKey={knowledge:'market.industry.prepare.step.knowledge',skill:'market.industry.prepare.step.skill',connector:'market.industry.prepare.step.connector',role:'market.industry.prepare.step.role'} as const
const stepOf=(step:string):keyof typeof stepKey|null=>step==='mcp'||step==='data-source'||step==='execution-tool'?'connector':step in stepKey?step as keyof typeof stepKey:null
/** 宿主标题与会话确认卡同一口径清洗：去掉控制与格式字符（含双向覆盖），合并空白，截到 30 字。 */
function plain(value:string):string{
 const flat=[...value.replace(/[\p{Cc}\p{Cf}]/gu,ch=>/\s/.test(ch)?' ':'').replace(/\s+/g,' ').trim()]
 return flat.length>30?flat.slice(0,30).join('')+'…':flat.join('')
}
/** 按组收拢同类条目；标题来自宿主清单，每组最多列 10 个，超出写「等 N 项」。 */
function grouped<K extends string>(rows:IndustryReadinessRow[],state:IndustryReadinessRow['state'],keyOf:(row:IndustryReadinessRow)=>K|null):[K,string[]][]{
 const groups=new Map<K,string[]>()
 for(const row of rows){const key=row.state===state?keyOf(row):null;if(key)groups.set(key,[...(groups.get(key)??[]),plain(row.title)])}
 return [...groups]
}
const names=(titles:string[],t:T)=>titles.slice(0,10).join(t('market.industry.prepare.separator'))+(titles.length>10?' '+t('market.industry.prepare.more',{count:titles.length}):'')

export type ReadinessRelation={kind:string;from:string;to:string}
// 宿主只给本批新建、关联技能与连接（含依赖应用）都已就绪的员工绑定技能并上岗；关联项还需要你操作时，一键只会建出暂停、无技能的员工，之后也不再补绑
const roleNeeds=['role-skill','role-connection']
export type ReadinessPresentationProps={readiness:IndustryReadiness|undefined;receipt:IndustryPrepareReceipt|undefined;confirming:boolean;busy:boolean;error:string;t:T;localize:(value:{code:string;message:string})=>string;onAsk:()=>void;onCancel:()=>void;onConfirm:()=>void;onOpen:(group:ReadinessGroupId)=>void;relations?:readonly ReadinessRelation[]|undefined;stale?:boolean|undefined;onRetry?:(()=>void)|undefined}
export function IndustryReadinessPresentation({readiness,receipt,confirming,busy,error,t,localize,onAsk,onCancel,onConfirm,onOpen,relations,stale,onRetry}:ReadinessPresentationProps){
 const retry=onRetry&&<button type="button" className={css.textButton} onClick={onRetry}>{t('market.industry.prepare.retry')}</button>
 if(!readiness)return error?<p role="alert">{error} {retry}</p>:null
 // 分母不含按需使用的任务模板与周期计划
 const {counts,rows}=readiness,total=counts.ready+counts.auto+counts.needsUser+counts.pending
 const tally=(...outcomes:string[])=>receipt?.results.filter(row=>outcomes.includes(row.outcome)).length??0
 // 回执按用户可见条目计（岗位的创建与上岗合成一项）：有失败算失败；有跳过且回执当时的清单快照里该条目归需要你操作（如岗位因技能未就绪保持暂停）算需要你操作；
 // 其余跳过或处理中算处理中；全部完成才算完成。只看回执自带的快照，之后清单刷新不改变这条回执；快照为 null 时跳过项计入处理中
 const outcomeOf=(id:string):'done'|'pending'|'needsUser'|'failed'=>{
  const steps=receipt!.results.filter(row=>row.itemInstanceId===id)
  if(steps.some(row=>row.outcome==='failed'))return 'failed'
  if(steps.some(row=>row.outcome==='skipped')&&receipt!.readiness?.rows.some(row=>row.itemInstanceId===id&&row.state==='needs-user'))return 'needsUser'
  return steps.every(row=>row.outcome==='done')?'done':'pending'
 }
 const itemOutcomes=receipt?[...new Set(receipt.results.map(row=>row.itemInstanceId))].map(outcomeOf):[]
 const itemCount=(outcome:ReturnType<typeof outcomeOf>)=>itemOutcomes.filter(value=>value===outcome).length
 const trusted=rows.filter(row=>row.state==='auto'&&row.trust)
 const auto=grouped(rows,'auto',row=>row.step?stepOf(row.step):null)
 // 随一键安装启用的应用逐项列出名称、包名与固定版本，不并入按组截断
 const apps=rows.filter(row=>row.state==='auto'&&row.step==='plugin')
 const actionEntry=(row:IndustryReadinessRow)=>row.entry==='model-settings'&&row.models?.length?null:row.entry
 // 员工依赖的应用需要你处理时逐项写明原因（会改动现有配置、不能安装、待重启、失败等）；未被员工依赖的应用条目没有原因，照旧并入「确认扩展安装」
 const pluginHolds=rows.filter(row=>row.state==='needs-user'&&row.entry==='plugin'&&row.reason)
 const todo=[...grouped(rows,'needs-user',row=>row.entry==='plugin'&&row.reason?null:actionEntry(row)),...grouped(rows,'optional',actionEntry)]
 const modelRows=rows.filter(row=>row.models?.length)
 // 可一键创建的员工若关联了需要你操作的技能或连接：先引导去处理（技能优先），一键降为显式次要入口
 const byId=new Map(rows.map(row=>[row.itemInstanceId,row] as const))
 const waiting=rows.filter(row=>row.kind==='role'&&row.state==='auto').map(role=>({role,needs:(relations??[]).filter(link=>link.from===role.itemInstanceId&&roleNeeds.includes(link.kind)).map(link=>byId.get(link.to)).filter((row):row is IndustryReadinessRow&{entry:Entry}=>row?.state==='needs-user'&&!!row.entry)})).filter(row=>row.needs.length)
 const waitingRoles=names(waiting.map(row=>plain(row.role.title)),t)
 const needs=[...new Map(waiting.flatMap(row=>row.needs).sort((a,b)=>Number(b.kind==='skill')-Number(a.kind==='skill')).map(row=>[row.itemInstanceId,row] as const)).values()]
 return <section className={css.panel} aria-label={t('market.industry.prepare.aria')}>
  <header className={css.head}><h3>{t(stale?'market.industry.prepare.titleStale':counts.ready>=total&&counts.pending===0?'market.industry.prepare.titleDone':'market.industry.prepare.title')}</h3><p>{t('market.industry.prepare.progress',{ready:counts.ready,total})}</p></header>
  {/* 重新核对失败：旧清单只作上次结果保留，不写成现在可用，也不在其上发起一键准备 */}
  {stale&&<p role="status">{t('market.industry.prepare.staleNote')} {retry}</p>}
  <progress className={css.meter} max={Math.max(total,1)} value={counts.ready} aria-hidden="true"/>
  <ul className={css.counts}>
   <li>{t('market.industry.prepare.auto',{count:counts.auto})}</li>
   <li>{t('market.industry.prepare.needsUser',{count:counts.needsUser})}</li>
   <li>{t('market.industry.prepare.optional',{count:counts.optional})}</li>
   {counts.pending>0&&<li>{t('market.industry.prepare.pending',{count:counts.pending})}</li>}
  </ul>
  {modelRows.length>0&&<div className={css.models}>
   <div className={css.modelHeader}><span>{t(entryKey['model-settings'],{titles:names(modelRows.map(row=>plain(row.title)),t)})}</span><button type="button" className={css.textButton} onClick={()=>onOpen('models')}>{t('market.industry.prepare.open')}</button></div>
   <ul className={css.rows}>{modelRows.flatMap(row=>row.models!.map(model=><li key={row.itemInstanceId+':'+model.catalogId+':'+model.usage}><span>{plain(row.title)} · {plain(model.title)} · v{model.version} · {t(model.required?'market.trust.required':'market.trust.optional')} · {t('market.industry.model.phase.'+model.phase)}</span></li>))}</ul>
  </div>}
  {counts.auto>0&&!confirming&&!stale&&(needs.length?<div role="status">
   <p>{t('market.industry.prepare.orderFirst',{titles:names(needs.map(row=>plain(row.title)),t),roles:waitingRoles})}</p>
   <p className={css.confirmActions}><button type="button" className={css.primaryButton} onClick={()=>onOpen(entryGroup[needs[0]!.entry])}>{t('market.industry.prepare.handleFirst')}</button> <button type="button" className={css.secondaryButton} disabled={busy} onClick={onAsk}>{t('market.industry.prepare.createPausedAnyway')}</button></p>
  </div>:<button type="button" className={css.primaryButton} disabled={busy} onClick={onAsk}>{busy?t('market.industry.prepare.running'):t('market.industry.prepare.run')}</button>)}
  {confirming&&!stale&&<div role="status">
   <p>{t('market.industry.prepare.confirm')}</p>
   {waiting.length>0&&<p>{t('market.industry.prepare.pausedWarning',{roles:waitingRoles})}</p>}
   <ul className={css.rows}>{auto.map(([key,titles])=><li key={key}>{t(stepKey[key],{titles:names(titles,t)})}</li>)}</ul>
   {apps.length>0&&<ul className={css.rows}>{apps.map(row=><li key={row.itemInstanceId}>{t('market.industry.prepare.appAuto',{title:plain(row.title),detail:row.app?(row.app.packageName?row.app.packageName+'@':'v')+row.app.version:'-'})}</li>)}</ul>}
   {trusted.length>0&&<ul className={css.rows}>{trusted.map(row=><li key={row.itemInstanceId}>{t('market.industry.prepare.trustedSkill',{title:plain(row.title),publisher:plain(row.trust!.publisher),license:plain(row.trust!.license??'-')})}</li>)}</ul>}
   <p className={css.confirmActions}><button type="button" className={css.primaryButton} disabled={busy} onClick={onConfirm}>{busy?t('market.industry.prepare.running'):t('market.industry.prepare.confirmRun')}</button> <button type="button" className={css.secondaryButton} disabled={busy} onClick={onCancel}>{t('market.industry.prepare.cancel')}</button></p>
  </div>}
  {receipt&&<p role="status">{t('market.industry.prepare.result',{done:itemCount('done'),pending:itemCount('pending'),needsUser:itemCount('needsUser'),failed:itemCount('failed')})}</p>}
  {receipt&&tally('failed')>0&&<ul className={css.rows}>{receipt.results.filter(row=>row.outcome==='failed').map(row=><li key={row.itemInstanceId+':'+row.step} role="alert">{plain(row.title)} · {localize({code:row.code??'teloa/dependency-unavailable',message:row.message??''})}</li>)}</ul>}
  {error&&<p role="alert">{error}</p>}
  {pluginHolds.length>0&&<ul className={css.rows}>{pluginHolds.map(row=><li key={row.itemInstanceId}><span>{t('market.industry.prepare.pluginReason.'+row.reason,{title:plain(row.title)})}</span><button type="button" className={css.textButton} onClick={()=>onOpen('extensions')}>{t('market.industry.prepare.open')}</button></li>)}</ul>}
  {todo.length>0&&<ul className={css.rows}>{todo.map(([entry,titles])=><li key={entry}><span>{t(entryKey[entry],{titles:names(titles,t)})}</span><button type="button" className={css.textButton} onClick={()=>onOpen(entryGroup[entry])}>{t('market.industry.prepare.open')}</button></li>)}</ul>}
 </section>
}

export function IndustryReadinessPanel({loadId,port,refreshKey,relations,onOpen,onRead}:{loadId:string;port:ReadinessPort;refreshKey:string;relations?:readonly ReadinessRelation[];onOpen:(group:ReadinessGroupId)=>void;onRead?:(value:IndustryReadiness|undefined)=>void}){
 const {locale,t}=useI18n()
 // port 由父组件每次渲染新建；放进 ref 避免 effect 反复读取
 const portRef=useRef(port);portRef.current=port
 const onReadRef=useRef(onRead);onReadRef.current=onRead
 const [readiness,setReadiness]=useState<IndustryReadiness>(),[receipt,setReceipt]=useState<IndustryPrepareReceipt>(),[confirming,setConfirming]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 // fresh：readiness 是本加载当前这轮核对读到的。重读开始、读取失败、一键后读不到最终清单时为 false，旧清单只能作上次结果
 const [fresh,setFresh]=useState(false),[attempt,setAttempt]=useState(0)
 // 每次读取（含一键准备）领一个序号，只有最新一次的结果能写入；迟到的旧读取一律丢弃
 const latest=useRef(0)
 const begin=()=>{const token=++latest.current;return (apply:()=>void)=>{if(token===latest.current)apply()}}
 // 只把当前核对过的清单回报给目录；没有当前核对时回报 undefined，同事详情随之只列名称，不另读、不猜
 useEffect(()=>{onReadRef.current?.(fresh?readiness:undefined)},[fresh,readiness])
 // refreshKey 由目录按本方案条目与各类实例的状态/修订、当前分组算出：相关操作后自动重读；attempt 是本人点「重新核对」
 useEffect(()=>{
  const settle=begin()
  setFresh(false);setError('')
  setReadiness(current=>current?.loadId===loadId?current:undefined);setReceipt(current=>current?.loadId===loadId?current:undefined)
  portRef.current.read(loadId).then(value=>settle(()=>{setReadiness(value);setFresh(true)}),reason=>settle(()=>setError(localizeWorkError(locale,reason))))
  return ()=>{latest.current++}
 },[loadId,locale,refreshKey,attempt])
 const confirm=async()=>{
  if(!readiness||busy)return
  setBusy(true);setError('')
  const settle=begin()
  const reread=async()=>{try{const value=await portRef.current.read(loadId);settle(()=>{setReadiness(value);setFresh(true)});return undefined}catch(reason){return reason}}
  try{
   const result=await portRef.current.prepare(loadId,readiness.digest);setReceipt(result)
   // 宿主已执行但最终清单待刷新：再读一次，读不到就把原清单留作上次结果并提示
   if(result.readiness)settle(()=>{setReadiness(result.readiness!);setFresh(true)})
   else{settle(()=>setFresh(false));const reason=await reread();if(reason!==undefined)settle(()=>setError(localizeWorkError(locale,reason)))}
  }
  catch(reason){settle(()=>{setFresh(false);setError(localizeWorkError(locale,reason))});await reread()}
  finally{setBusy(false);setConfirming(false)}
 }
 return <IndustryReadinessPresentation readiness={readiness} receipt={receipt} confirming={confirming} busy={busy} error={error} stale={!fresh&&!!error} onRetry={()=>setAttempt(value=>value+1)} t={t as T} localize={value=>localizeWorkError(locale,value)} onAsk={()=>setConfirming(true)} onCancel={()=>setConfirming(false)} onConfirm={()=>void confirm()} onOpen={onOpen} relations={relations}/>
}
