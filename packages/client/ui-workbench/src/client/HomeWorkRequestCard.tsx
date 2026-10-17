import {useEffect,useState} from 'react'
import {RefreshCw} from 'lucide-react'
import type {ToolCallViewProps} from '@deepseek-ai/dsh-client-ui-tool/client'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {useBusinessScopes} from './business-scope-context.js'
import {readHomeWorkStatus,changeHomeWorkStatus,type HomeWorkStatus,type HomeWorkStatusCall} from './home-work-status.js'
import css from './HomeWorkRequestCard.module.css'
import {ToolbarIconButton} from './ToolbarIconButton.js'

type Actions={call:HomeWorkStatusCall;openTask:(id:string)=>void}
const needsNewArrangement=(member:HomeWorkStatus['members'][number])=>member.status==='failed'&&member.run?.state==='prepared'
export function HomeWorkRequestCard({sessionId,block,phase,inspect,call,openTask}:ToolCallViewProps&Actions){
 const {locale}=useI18n(),zh=locale.startsWith('zh')
 if(phase!=='result')return <p role="status">{zh?'正在安排工作…':'Arranging work…'}</p>
 let rows:HomeWorkStatus[]=[]
 if(!block.isError)try{const parsed:unknown=JSON.parse(block.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'));rows=(Array.isArray(parsed)?parsed:[parsed]).map(row=>readHomeWorkStatus(row,sessionId))}catch{/* 无法核对时只提供原始工具记录。 */}
 if(!rows.length)return <div className={css.card}><p>{zh?(block.isError?'工作安排未完成，请查看详情。':'本会话还没有可显示的交办。'):(block.isError?'Work could not be arranged. View details.':'No work requests to show in this conversation.')}</p>{inspect&&<button type="button" onClick={inspect}>{zh?'查看详情':'View details'}</button>}</div>
 return <div>{rows.map(row=><HomeWorkStatusCard key={row.sessionId+':'+row.requestId} initial={row} call={call} openTask={openTask}/>)}</div>
}

export function HomeWorkStatusCard({initial,call,openTask,managed=false,onChange}:Actions&{initial:HomeWorkStatus;managed?:boolean;onChange?:(row:HomeWorkStatus)=>void}){
 const {locale}=useI18n(),zh=locale.startsWith('zh'),scopes=useBusinessScopes()
 const [row,setRow]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState<string>()
 const waiting=row.members.some(member=>member.status==='waiting')
 useEffect(()=>{setRow(initial);setError(undefined)},[initial])
 useEffect(()=>{
  if(managed||!waiting||busy)return
  const controller=new AbortController()
  const timer=setTimeout(()=>{void changeHomeWorkStatus(call,row,'status',controller.signal).then(next=>{if(!controller.signal.aborted){setRow(next);setError(undefined)}}).catch(cause=>{if(!controller.signal.aborted)setError(localizeWorkError(locale,cause))})},10000)
  return()=>{clearTimeout(timer);controller.abort()}
 },[row,waiting,busy,call,locale,managed])
 const act=async(action:'status'|'stop'|'resume')=>{
  if(busy)return
  setBusy(true);setError(undefined)
  try{const next=await changeHomeWorkStatus(call,row,action);setRow(next);onChange?.(next)}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}
 }
 const names=zh?{received:'已收到',waiting:row.stoppedAt?'停止中':'等待中',unavailable:'不可用',failed:'未完成',stopped:'已停止'}:{received:'Received',waiting:row.stoppedAt?'Stopping':'Waiting',unavailable:'Unavailable',failed:'Incomplete',stopped:'Stopped'}
 const taskNames=locale==='zh-Hant'||locale==='zh-TW'||locale==='zh-HK'?{completed:'已完成',review:'待驗收',running:'進行中',ready:'待開始',paused:'已暫停',blocked:'受阻',cancelled:'已取消',unknown:'狀態待核對',revision:'成果修改'}:zh?{completed:'已完成',review:'待验收',running:'进行中',ready:'待开始',paused:'已暂停',blocked:'受阻',cancelled:'已取消',unknown:'状态待核对',revision:'成果修改'}:{completed:'Completed',review:'Awaiting review',running:'In progress',ready:'Ready',paused:'Paused',blocked:'Blocked',cancelled:'Cancelled',unknown:'Status needs checking',revision:'Artifact revision'}
 const progress=(member:HomeWorkStatus['members'][number])=>{
  const state=member.task?.state
  if(state===undefined)return {state:member.status,label:names[member.status]} // 旧回包不推测任务已完成。
  if(state==='completed'||state==='cancelled'||state==='unknown')return {state,label:taskNames[state]}
  if(member.status==='failed'||member.status==='stopped'||member.status==='unavailable'||row.stoppedAt&&member.status==='waiting')return {state:member.status,label:names[member.status]}
  if(state==='waiting')return member.status==='received'&&member.run?.state==='ended'?{state:'review',label:taskNames.review}:{state:member.status,label:names[member.status]}
  return {state,label:taskNames[state]}
 }
 const revision=(member:HomeWorkStatus['members'][number])=>{const source=member.run?.artifactRevision;return source?`${taskNames.revision} · v${source.baseVersion} ${zh?'至':'to'} v${source.baseVersion+1}`:undefined}
 const taskLabel=(member:HomeWorkStatus['members'][number])=>[member.task!.title,progress(member).label,revision(member)].filter(Boolean).join(' · ')
 const singleTask=row.members.length===1&&row.members[0]?.task?.title===row.title?row.members[0].task:undefined
 const canStop=waiting&&!row.stoppedAt,canResume=!row.stoppedAt&&row.members.some(member=>member.status==='failed')&&!row.members.some(needsNewArrangement)
 return <section className={css.card} aria-label={zh?'交办进度':'Work progress'}>
  <header><div className={css.heading}>{singleTask?<button type="button" className={css.taskLink} data-task-id={singleTask.id} aria-label={taskLabel(row.members[0]!)} onClick={()=>openTask(singleTask.id)}>{row.title}</button>:<strong>{row.title}</strong>}<span>{scopes[row.scope]??row.scope}</span></div><ToolbarIconButton className={css.refresh} label={zh?'刷新进度':'Refresh progress'} icon={RefreshCw} disabled={busy} onClick={()=>void act('status')}/></header>
  <ul>{row.members.map(member=><li key={member.roleId??'owner'}><div className={css.member}><strong>{member.name}</strong><span className={css.status} data-state={progress(member).state}>{progress(member).label}</span>{member.task&&!singleTask&&<button type="button" className={css.taskLink} data-task-id={member.task.id} aria-label={taskLabel(member)} onClick={()=>openTask(member.task!.id)}>{member.task.title}</button>}</div>{revision(member)&&<small className={css.revision} title={member.run?.artifactRevision?.title}>{revision(member)}</small>}{member.reason&&<p>{member.reason}</p>}{needsNewArrangement(member)&&member.task&&<p>{zh?'请先查看原任务，核对负责人后重新安排。':'Open the original task, review the owner, and arrange the work again.'}</p>}{member.result&&<details><summary>{zh?'查看结果':'View result'}</summary><p className={css.result}>{member.result}</p></details>}</li>)}</ul>
  {(canStop||canResume)&&<footer>{canStop&&<button type="button" disabled={busy} onClick={()=>void act('stop')}>{zh?'停止剩余工作':'Stop remaining work'}</button>}{canResume&&<button type="button" disabled={busy} onClick={()=>void act('resume')}>{zh?'重试未完成的工作':'Retry incomplete work'}</button>}</footer>}
  {error&&<p role="alert">{error}</p>}
 </section>
}
