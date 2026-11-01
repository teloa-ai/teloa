import {useEffect,useRef,useState} from 'react'
import type {WorkBudgetPolicy} from '@teloa/contract'
import type {BudgetView,WorkBudgetApi} from './work-budget-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import {RefreshCw} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
const keys=['maxGoalRounds','maxTokens','maxConcurrent','maxElapsedMs','maxRetries','stagnationRounds'] as const
/** 分钟向上取整：刚开始的调用也显示为已占用，不把未满一分钟显示成零。 */
const usage=(view:BudgetView)=>({tokens:view.usedTokens,tokenLimit:view.policy.maxTokens,rounds:view.usedRounds,roundLimit:view.policy.maxGoalRounds,concurrent:view.concurrent,concurrentLimit:view.policy.maxConcurrent,elapsed:Math.ceil(view.usedElapsedMs/60000),elapsedLimit:view.policy.maxElapsedMs/60000})
/** 当前已达上限的首个维度：职责先于本人，与服务端核对顺序一致；用于在任务页直接说明为何不能继续。 */
function exhaustion(account:BudgetView|undefined,owner:BudgetView|undefined){
 for(const [view,scope] of [[account,'work'],[owner,'owner']] as const){
  if(!view)continue
  const reason=view.usedTokens>=view.policy.maxTokens?'tokens':view.usedRounds>=view.policy.maxGoalRounds?'rounds':view.concurrent>=view.policy.maxConcurrent?'concurrent':view.usedElapsedMs>=view.policy.maxElapsedMs?'elapsed':undefined
  if(reason)return {code:'teloa/budget-exhausted',details:{reason,scope}}
 }
 return undefined
}
const labels={'maxGoalRounds':'planWork.rounds','maxTokens':'planWork.tokens','maxConcurrent':'planWork.concurrent','maxElapsedMs':'planWork.elapsed','maxRetries':'planWork.retries','stagnationRounds':'planWork.stagnation'} as const
type BudgetScope='account'|'owner'
type BudgetSource={api:WorkBudgetApi;budgetAccountId:string;live:boolean}
type BudgetSnapshot={source:BudgetSource;account:BudgetView;owner:BudgetView}
type BudgetDraft={source:BudgetSource;scope:BudgetScope;version:number;policy:WorkBudgetPolicy;confirmed:boolean}
type BudgetActivity={source:BudgetSource;busy:boolean;error:string;discarded:boolean}
export function WorkBudgetPanel({api,budgetAccountId,recoveryOnly=false,initialScope='account'}:{api:WorkBudgetApi;budgetAccountId:string;recoveryOnly?:boolean;initialScope?:BudgetScope}){
 const {t,locale}=useI18n(),sourceRef=useRef<BudgetSource>({api,budgetAccountId,live:true}),[snapshot,setSnapshot]=useState<BudgetSnapshot>(),[scope,setScope]=useState<BudgetScope>(initialScope),[draft,setDraft]=useState<BudgetDraft>(),[activity,setActivity]=useState<BudgetActivity>(),[,refreshRecovery]=useState(0)
 if(sourceRef.current.api!==api||sourceRef.current.budgetAccountId!==budgetAccountId)sourceRef.current={api,budgetAccountId,live:true}
 const source=sourceRef.current,isCurrent=()=>source.live&&sourceRef.current===source,read=snapshot?.source===source?snapshot:undefined,account=read?.account,owner=read?.owner,current=scope==='account'?account:owner
 const {busy,error,discarded}=activity?.source===source?activity:{busy:false,error:'',discarded:false}
 const report=(patch:Partial<Omit<BudgetActivity,'source'>>)=>{if(isCurrent())setActivity(previous=>({busy:false,error:'',discarded:false,...(previous?.source===source?previous:{}),...patch,source}))}
 useEffect(()=>{source.live=true;return()=>{source.live=false}},[source])
 useEffect(()=>{setScope(initialScope);setDraft(undefined)},[source,initialScope])
 // 草稿与确认绑定同一目标和版本；切换范围的首帧就使用目标策略，不能等 effect 搬移旧表单。
 const activeDraft=draft?.source===source&&draft.scope===scope&&draft.version===current?.version?draft:undefined,policy=activeDraft?.policy??current?.policy,confirmed=activeDraft?.confirmed??false
 const edit=(policy:WorkBudgetPolicy,confirmed=false)=>{if(isCurrent()&&current)setDraft({source,scope,version:current.version,policy,confirmed})}
 const load=async()=>{const [account,owner]=await Promise.all([api.read(budgetAccountId),api.readOwner()]);if(isCurrent())setSnapshot({source,account,owner})}
 const accept=async(value:BudgetView)=>{
  if(!isCurrent())return
  if(!read||value.budgetAccountId&&value.budgetAccountId!==budgetAccountId){await load();return}
  setSnapshot(previous=>previous?.source===source?{...previous,...(value.budgetAccountId?{account:value}:{owner:value})}:previous)
 }
 useEffect(()=>{let live=true;report({error:''});if(recoveryOnly)return;void Promise.all([api.read(budgetAccountId),api.readOwner()]).then(([account,owner])=>{if(live&&isCurrent())setSnapshot({source,account,owner})},cause=>{if(live)report({error:localizeWorkError(locale,cause)})});return()=>{live=false}},[source,locale,recoveryOnly])
 const act=async(work:()=>Promise<BudgetView|void>)=>{if(busy||!isCurrent())return;report({busy:true,error:'',discarded:false});try{const value=await work();if(!isCurrent())return;if(value&&!recoveryOnly)await accept(value);if(isCurrent())setDraft(undefined)}catch(cause){report({error:localizeWorkError(locale,cause)})}finally{
  report({busy:false})
  // 同一 API 的旧回执可清除共享 journal；只刷新恢复状态，不能把旧读数或草稿带到新职责。
  if(!isCurrent()&&sourceRef.current.live&&sourceRef.current.api===api)refreshRecovery(value=>value+1)
 }}
 const refresh=()=>act(load)
 const exhausted=exhaustion(account,owner)
 if(recoveryOnly){
  const pending=api.pending(),message=api.recoveryMessage()
  if(pending?.budgetAccountId&&pending.budgetAccountId!==budgetAccountId||!pending&&!message)return null
  return <section className={css.pendingAction} role="status">
   <p>{message?localizeWorkError(locale,message):t('planWork.budget.unknown')}</p>
   {error&&<p role="alert">{error}</p>}
   <div className={css.buttons}>
    {pending&&!message&&<button type="button" disabled={busy} onClick={()=>void act(()=>api.recover())}>{t('planWork.recover')}</button>}
    <button type="button" disabled={busy} onClick={()=>{try{api.discard();report({discarded:true,error:''})}catch(cause){report({error:localizeWorkError(locale,cause)})}}}>{t('recovery.discard')}</button>
   </div>
  </section>
 }
 return <details className={css.block} open={exhausted?true:undefined}><summary>{t('planWork.budget.title')}</summary>{exhausted&&<p role="alert">{localizeWorkError(locale,exhausted)}</p>}<p>{t('planWork.budget.boundary')}</p>{account&&<p>{t('planWork.budget.account')}：{t('planWork.budget.used',usage(account))}</p>}{owner&&<p>{t('planWork.budget.owner')}：{t('planWork.budget.used',usage(owner))}</p>}{error&&<p role="alert">{error}</p>}{api.recoveryMessage()&&<p role="alert">{localizeWorkError(locale,api.recoveryMessage())} {t('recovery.nextStep')}</p>}{discarded&&<p role="status">{t('recovery.discarded')}</p>}{(api.pending()||api.recoveryMessage())&&<div className={css.buttons}>{api.pending()&&<><span>{t('planWork.budget.unknown')}</span><button type="button" disabled={busy||!!api.recoveryMessage()} onClick={()=>void act(()=>api.recover())}>{t('planWork.recover')}</button></>}<button type="button" disabled={busy} onClick={()=>{report({discarded:false});try{api.discard();if(policy)edit(policy);report({discarded:true})}catch(cause){report({error:localizeWorkError(locale,cause)})}}}>{t('recovery.discard')}</button></div>}
 <ToolbarIconButton label={t('taskExecution.refresh')} icon={RefreshCw} disabled={busy} onClick={()=>void refresh()}/>
 {current&&policy&&<form className={css.form} onSubmit={event=>{event.preventDefault();if(!confirmed||api.pending()||api.recoveryMessage()||busy)return;void act(()=>api.configure(current,policy))}}><label>{t('planWork.budget.scope')}<select disabled={busy} value={scope} onChange={event=>{setScope(event.target.value as BudgetScope);setDraft(undefined)}}><option value="account">{t('planWork.budget.account')}</option><option value="owner">{t('planWork.budget.owner')}</option></select></label>{keys.map(key=><label key={key}>{t(labels[key])}<input required type="number" min={key==='maxRetries'?0:1} step={1} disabled={busy} value={key==='maxElapsedMs'?policy[key]/60000:policy[key]} onChange={event=>{const value=Number(event.target.value);edit({...policy,[key]:key==='maxElapsedMs'?value*60000:value})}}/></label>)}<label><input required type="checkbox" disabled={busy||!!api.pending()} checked={confirmed} onChange={event=>edit(policy,event.target.checked)}/>{t('planWork.budget.confirm')}</label><button type="submit" disabled={busy||!confirmed||!!api.pending()||!!api.recoveryMessage()||keys.some(k=>!Number.isSafeInteger(policy[k])||policy[k]<(k==='maxRetries'?0:1))}>{t(busy?'continuous.common.saving':'planWork.budget.save')}</button></form>}
 </details>
}
