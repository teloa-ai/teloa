import {useEffect,useRef,useState} from 'react'
import type {WorkBudgetPolicy} from '@teloa/contract'
import type {BudgetView,WorkBudgetApi} from './work-budget-api.js'
import {WorkBudgetFields,isWorkBudgetIncrease,isWorkBudgetPolicyValid} from './WorkBudgetFields.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import layout from './WorkBudgetPanel.module.css'
import {RefreshCw} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
/** 当前已达有限上限的首个维度；不限不与用量比较，也不把已用量视为零。 */
function exhaustion(account:BudgetView|undefined,owner:BudgetView|undefined){
 for(const [view,scope] of [[account,'work'],[owner,'owner']] as const){
  if(!view)continue
  const reached=(used:number,limit:number|null)=>limit!==null&&used>=limit
  const reason=reached(view.usedTokens,view.policy.maxTokens)?'tokens':reached(view.usedRounds,view.policy.maxGoalRounds)?'rounds':reached(view.concurrent,view.policy.maxConcurrent)?'concurrent':reached(view.usedElapsedMs,view.policy.maxElapsedMs)?'elapsed':undefined
  if(reason)return {code:'teloa/budget-exhausted',details:{reason,scope}}
 }
 return undefined
}
type BudgetScope='account'|'owner'
type BudgetSource={api:WorkBudgetApi;budgetAccountId:string;live:boolean}
type BudgetSnapshot={source:BudgetSource;account:BudgetView;owner:BudgetView}
type BudgetDraft={source:BudgetSource;scope:BudgetScope;version:number;policy:WorkBudgetPolicy;confirmed:boolean}
type BudgetActivity={source:BudgetSource;busy:boolean;error:string;discarded:boolean}
export function WorkBudgetPanel({api,budgetAccountId,recoveryOnly=false,initialScope='account'}:{api:WorkBudgetApi;budgetAccountId:string;recoveryOnly?:boolean;initialScope?:BudgetScope}){
 const {t,locale}=useI18n(),sourceRef=useRef<BudgetSource>({api,budgetAccountId,live:true}),[snapshot,setSnapshot]=useState<BudgetSnapshot>(),[scope,setScope]=useState<BudgetScope>(initialScope),[drafts,setDrafts]=useState<Partial<Record<BudgetScope,BudgetDraft>>>({}),[notice,setNotice]=useState<{source:BudgetSource;text:string}>(),[expanded,setExpanded]=useState(false),conflicted=useRef(new Set<BudgetScope>()),[activity,setActivity]=useState<BudgetActivity>(),[saved,setSaved]=useState<{source:BudgetSource;scope:BudgetScope;view:BudgetView}>(),[,refreshRecovery]=useState(0)
 if(sourceRef.current.api!==api||sourceRef.current.budgetAccountId!==budgetAccountId)sourceRef.current={api,budgetAccountId,live:true}
 const source=sourceRef.current,isCurrent=()=>source.live&&sourceRef.current===source,read=snapshot?.source===source?snapshot:undefined,account=read?.account,owner=read?.owner,current=scope==='account'?account:owner
 const {busy,error,discarded}=activity?.source===source?activity:{busy:false,error:'',discarded:false}
 const report=(patch:Partial<Omit<BudgetActivity,'source'>>)=>{if(isCurrent())setActivity(previous=>({busy:false,error:'',discarded:false,...(previous?.source===source?previous:{}),...patch,source}))}
 useEffect(()=>{source.live=true;return()=>{source.live=false}},[source])
 useEffect(()=>{setScope(initialScope);setDrafts({});setNotice(undefined);conflicted.current.clear()},[source,initialScope])
 // 草稿与确认绑定同一目标和版本；切换范围的首帧就使用目标策略，不能等 effect 搬移旧表单。
 const scopedDraft=drafts[scope],activeDraft=scopedDraft?.source===source&&scopedDraft.scope===scope&&scopedDraft.version===current?.version?scopedDraft:undefined,policy=activeDraft?.policy??current?.policy,confirmed=activeDraft?.confirmed??false
 const edit=(policy:WorkBudgetPolicy,confirmed=false)=>{if(isCurrent()&&current)setDrafts(previous=>({...previous,[scope]:{source,scope,version:current.version,policy,confirmed}}))}
 const load=async()=>{const [account,owner]=await Promise.all([api.read(budgetAccountId),api.readOwner()]);if(!isCurrent())return
  setSnapshot({source,account,owner});const rebasing=new Set(conflicted.current);conflicted.current.clear();if(rebasing.size)setNotice({source,text:t('planWork.budget.refreshedDraft')})
  setDrafts(previous=>{const next={...previous};for(const target of ['account','owner'] as const){const draft=previous[target],value=target==='account'?account:owner;if(draft?.source!==source)continue;if(rebasing.has(target)){next[target]={...draft,version:value.version,confirmed:false}}else if(draft.version===value.version)next[target]={...draft,confirmed:false};else delete next[target]}return next})
 }
 const accept=async(value:BudgetView)=>{
  if(!isCurrent())return
  if(!read||value.budgetAccountId&&value.budgetAccountId!==budgetAccountId){await load();return}
  setSnapshot(previous=>previous?.source===source?{...previous,...(value.budgetAccountId?{account:value}:{owner:value})}:previous)
 }
 useEffect(()=>{let live=true;report({error:''});if(recoveryOnly)return;void Promise.all([api.read(budgetAccountId),api.readOwner()]).then(([account,owner])=>{if(live&&isCurrent())setSnapshot({source,account,owner})},cause=>{if(live)report({error:localizeWorkError(locale,cause)})});return()=>{live=false}},[source,locale,recoveryOnly])
 const act=async(work:()=>Promise<BudgetView|void>,kind:'refresh'|'save'|'recover'='refresh')=>{
  if(busy||!isCurrent())return
  report({busy:true,error:'',discarded:false});setSaved(undefined);setNotice(undefined)
  try{const value=await work();if(!isCurrent())return;if(value&&!recoveryOnly){await accept(value);if(isCurrent()&&kind!=='refresh'){const target:BudgetScope=value.budgetAccountId?'account':'owner';setSaved({source,scope:target,view:value});setExpanded(true);setDrafts(previous=>{const next={...previous};delete next[target];return next});conflicted.current.delete(target)}}}
  catch(cause){if(isCurrent()){const conflict=!!cause&&typeof cause==='object'&&'code'in cause&&cause.code==='teloa/version-conflict';if(conflict)conflicted.current.add(scope);setDrafts(previous=>{const draft=previous[scope];return draft?.source===source?{...previous,[scope]:{...draft,confirmed:false}}:previous});report({error:conflict?t('planWork.budget.conflict'):localizeWorkError(locale,cause)})}}
  finally{report({busy:false});if(!isCurrent()&&sourceRef.current.live&&sourceRef.current.api===api)refreshRecovery(value=>value+1)}
 }
 const refresh=()=>act(load)
 const limit=(value:number|null,minutes=false)=>value===null?t('planWork.budget.unlimited'):(minutes?value/60000:value).toLocaleString(locale)
 const usage=(view:BudgetView)=>({tokens:view.usedTokens.toLocaleString(locale),tokenLimit:limit(view.policy.maxTokens),rounds:view.usedRounds.toLocaleString(locale),roundLimit:limit(view.policy.maxGoalRounds),concurrent:view.concurrent.toLocaleString(locale),concurrentLimit:limit(view.policy.maxConcurrent),elapsed:Math.ceil(view.usedElapsedMs/60000).toLocaleString(locale),elapsedLimit:limit(view.policy.maxElapsedMs,true)})
 const exhausted=exhaustion(account,owner),increase=current&&policy?isWorkBudgetIncrease(current.policy,policy):true,pending=api.pending(),pendingHere=!pending||pending.kind==='owner'||pending.budgetAccountId===budgetAccountId
 const originalPending=()=>pendingHere&&JSON.stringify(api.pending())===JSON.stringify(pending)
 const recover=()=>{if(!originalPending()){report({error:t('planWork.budget.pendingChanged')});return}void act(()=>api.recover(),'recover')}
 if(recoveryOnly){
  const message=api.recoveryMessage()
  if(pending?.budgetAccountId&&pending.budgetAccountId!==budgetAccountId||!pending&&!message)return null
  return <section className={css.pendingAction} role="status">
   <p>{message?localizeWorkError(locale,message):t('planWork.budget.unknown')}</p>
   {error&&<p role="alert">{error}</p>}
   <div className={css.buttons}>
    {pending&&!message&&<button type="button" disabled={busy} onClick={recover}>{t('planWork.recover')}</button>}
    <button type="button" disabled={busy} onClick={()=>{try{api.discard();report({discarded:true,error:''})}catch(cause){report({error:localizeWorkError(locale,cause)})}}}>{t('recovery.discard')}</button>
   </div>
  </section>
 }
 return <details className={css.block+' '+layout.panel} open={expanded||exhausted?true:undefined} onToggle={event=>setExpanded(event.currentTarget.open)}><summary>{t('planWork.budget.title')}</summary>{exhausted&&<p role="alert">{localizeWorkError(locale,exhausted)}</p>}<p>{t('planWork.budget.boundary')}</p><p className={layout.hint}>{t('planWork.budget.unlimitedBoundary')}</p><dl className={layout.usage}>{account&&<div><dt>{t('planWork.budget.account')}</dt><dd>{t('planWork.budget.used',usage(account))}</dd></div>}{owner&&<div><dt>{t('planWork.budget.owner')}</dt><dd>{t('planWork.budget.used',usage(owner))}</dd></div>}</dl>{notice?.source===source&&<p role="status">{notice.text}</p>}{error&&<p role="alert">{error}</p>}{saved?.source===source&&<div role="status"><p>{t('planWork.budget.saved',{scope:t(saved.scope==='account'?'planWork.budget.account':'planWork.budget.owner'),version:saved.view.version})}</p><p>{t('planWork.budget.used',usage(saved.view))}</p></div>}{api.recoveryMessage()&&<p role="alert">{localizeWorkError(locale,api.recoveryMessage())} {t('recovery.nextStep')}</p>}{discarded&&<p role="status">{t('recovery.discarded')}</p>}{(api.pending()||api.recoveryMessage())&&<div className={css.buttons}>{api.pending()&&<><span>{t(pendingHere?'planWork.budget.unknown':'planWork.budget.foreign')}</span><button type="button" disabled={busy||!!api.recoveryMessage()||!pendingHere} onClick={recover}>{t('planWork.recover')}</button></>}<button type="button" disabled={busy||!pendingHere} onClick={()=>{report({discarded:false});try{if(!originalPending()){report({error:t('planWork.budget.pendingChanged')});return}api.discard();if(policy)edit(policy);report({discarded:true})}catch(cause){report({error:localizeWorkError(locale,cause)})}}}>{t('recovery.discard')}</button></div>}
 <ToolbarIconButton label={t('taskExecution.refresh')} icon={RefreshCw} disabled={busy} onClick={()=>void refresh()}/>
 {current&&policy&&<form className={css.form} onSubmit={event=>{event.preventDefault();if(!confirmed||api.pending()||api.recoveryMessage()||busy||!isWorkBudgetPolicyValid(policy))return;void act(()=>api.configure(current,policy),'save')}}><label>{t('planWork.budget.scope')}<select aria-label={t('planWork.budget.scope')} disabled={busy} value={scope} onChange={event=>{setScope(event.target.value as BudgetScope);setSaved(undefined);setDrafts(previous=>{const next={...previous};for(const target of ['account','owner'] as const)if(next[target])next[target]={...next[target]!,confirmed:false};return next})}}><option value="account">{t('planWork.budget.account')}</option><option value="owner">{t('planWork.budget.owner')}</option></select></label><WorkBudgetFields key={scope} value={policy} includeRecovery={scope==='account'} disabled={busy} onChange={next=>edit(next)}/>{scope==='owner'&&<p className={layout.hint}>{t('planWork.budget.ownerRecoveryBoundary')}</p>}<p className={layout.hint}>{t(increase?'planWork.budget.dynamicIncrease':'planWork.budget.lowerProtection')}</p><label><input required type="checkbox" disabled={busy||!!api.pending()} checked={confirmed} onChange={event=>edit(policy,event.target.checked)}/>{t('planWork.budget.confirm')}</label><button type="submit" disabled={busy||!confirmed||!!api.pending()||!!api.recoveryMessage()||!isWorkBudgetPolicyValid(policy)}>{t(busy?'continuous.common.saving':'planWork.budget.save')}</button></form>}
 </details>
}
