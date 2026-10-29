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
type Scope='account'|'owner'
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
export function WorkBudgetPanel({api,budgetAccountId}:{api:WorkBudgetApi;budgetAccountId:string}){
 const {t,locale}=useI18n(),[account,setAccount]=useState<BudgetView>(),[owner,setOwner]=useState<BudgetView>(),[scope,setScope]=useState<Scope>('account'),[drafts,setDrafts]=useState<Partial<Record<Scope,WorkBudgetPolicy>>>({}),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[discarded,setDiscarded]=useState(false),[saved,setSaved]=useState<{scope:Scope;view:BudgetView}>(),[expanded,setExpanded]=useState(false)
 const identity=useRef({api,budgetAccountId}),dirty=useRef({account:false,owner:false}),acting=useRef(false)
 if(identity.current.api!==api||identity.current.budgetAccountId!==budgetAccountId)identity.current={api,budgetAccountId}
 const current=scope==='account'?account:owner,policy=drafts[scope]
 const limit=(value:number|null,minutes=false)=>value===null?t('planWork.budget.unlimited'):(minutes?value/60000:value).toLocaleString(locale)
 const usage=(view:BudgetView)=>({tokens:view.usedTokens.toLocaleString(locale),tokenLimit:limit(view.policy.maxTokens),rounds:view.usedRounds.toLocaleString(locale),roundLimit:limit(view.policy.maxGoalRounds),concurrent:view.concurrent.toLocaleString(locale),concurrentLimit:limit(view.policy.maxConcurrent),elapsed:Math.ceil(view.usedElapsedMs/60000).toLocaleString(locale),elapsedLimit:limit(view.policy.maxElapsedMs,true)})
 useEffect(()=>{const token=identity.current;let live=true;dirty.current={account:false,owner:false};acting.current=false;setBusy(false);setAccount(undefined);setOwner(undefined);setDrafts({});setConfirmed(false);setError('');setNotice('');setSaved(undefined);setDiscarded(false);void Promise.all([api.read(budgetAccountId),api.readOwner()]).then(([a,o])=>{if(live&&identity.current===token){setAccount(a);setOwner(o);setDrafts({account:a.policy,owner:o.policy})}},cause=>{if(live&&identity.current===token)setError(localizeWorkError(locale,cause))});return()=>{live=false;if(identity.current===token)identity.current={...token}}},[api,budgetAccountId])
 const pending=api.pending(),pendingHere=!pending||pending.kind==='owner'||pending.budgetAccountId===budgetAccountId
 const act=async(operation:()=>Promise<BudgetView>,kind:'refresh'|'save'|'recover')=>{
  if(acting.current)return
  const token=identity.current;acting.current=true;setBusy(true);setError('');setNotice('');setSaved(undefined);setDiscarded(false)
  try{
   const value=await operation();if(identity.current!==token)return
   if(value.budgetAccountId&&value.budgetAccountId!==budgetAccountId)throw Error('额度回执不属于当前工作。')
   const target:Scope=value.budgetAccountId?'account':'owner'
   if(target==='account')setAccount(value);else setOwner(value)
   if(kind!=='refresh'){dirty.current[target]=false;setDrafts(previous=>({...previous,[target]:value.policy}));setSaved({scope:target,view:value});setExpanded(true)}
   setConfirmed(false)
  }catch(cause){if(identity.current===token){setError(cause&&typeof cause==='object'&&'code'in cause&&cause.code==='teloa/version-conflict'?t('planWork.budget.conflict'):localizeWorkError(locale,cause));setConfirmed(false)}}finally{if(identity.current===token){acting.current=false;setBusy(false)}}
 }
 const refresh=()=>act(async()=>{const token=identity.current,[a,o]=await Promise.all([api.read(budgetAccountId),api.readOwner()]);if(identity.current===token){setOwner(o);setDrafts(previous=>({account:dirty.current.account?previous.account??a.policy:a.policy,owner:dirty.current.owner?previous.owner??o.policy:o.policy}));if(dirty.current.account||dirty.current.owner)setNotice(t('planWork.budget.refreshedDraft'))}return a},'refresh')
 const exhausted=exhaustion(account,owner),increase=current&&policy?isWorkBudgetIncrease(current.policy,policy):true
 return <details className={css.block+' '+layout.panel} open={expanded||exhausted?true:undefined} onToggle={event=>setExpanded(event.currentTarget.open)}><summary>{t('planWork.budget.title')}</summary>{exhausted&&<p role="alert">{localizeWorkError(locale,exhausted)}</p>}<p>{t('planWork.budget.boundary')}</p><p className={layout.hint}>{t('planWork.budget.unlimitedBoundary')}</p><dl className={layout.usage}>{account&&<div><dt>{t('planWork.budget.account')}</dt><dd>{t('planWork.budget.used',usage(account))}</dd></div>}{owner&&<div><dt>{t('planWork.budget.owner')}</dt><dd>{t('planWork.budget.used',usage(owner))}</dd></div>}</dl>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{saved&&<div role="status"><p>{t('planWork.budget.saved',{scope:t(saved.scope==='account'?'planWork.budget.account':'planWork.budget.owner'),version:saved.view.version})}</p><p>{t('planWork.budget.used',usage(saved.view))}</p></div>}{api.recoveryMessage()&&<p role="alert">{localizeWorkError(locale,api.recoveryMessage())} {t('recovery.nextStep')}</p>}{discarded&&<p role="status">{t('recovery.discarded')}</p>}{(pending||api.recoveryMessage())&&<div className={css.buttons}>{pending&&<><span>{t(pendingHere?'planWork.budget.unknown':'planWork.budget.foreign')}</span><button type="button" disabled={busy||!!api.recoveryMessage()||!pendingHere} onClick={()=>{const latest=api.pending();if(!latest||JSON.stringify(latest)!==JSON.stringify(pending)){setError(t('planWork.budget.pendingChanged'));return}void act(()=>api.recover(),'recover')}}>{t('planWork.recover')}</button></>}<button type="button" disabled={busy||!pendingHere} onClick={()=>{setDiscarded(false);try{if(JSON.stringify(api.pending())!==JSON.stringify(pending)){setError(t('planWork.budget.pendingChanged'));return}api.discard();setConfirmed(false);setDiscarded(true)}catch(cause){setError(localizeWorkError(locale,cause))}}}>{t('recovery.discard')}</button></div>}
 <ToolbarIconButton label={t('taskExecution.refresh')} icon={RefreshCw} disabled={busy} onClick={()=>void refresh()}/>
 {current&&policy&&<form className={css.form} onSubmit={event=>{event.preventDefault();if(!confirmed||api.pending()||api.recoveryMessage()||busy||!isWorkBudgetPolicyValid(policy))return;void act(()=>api.configure(current,policy),'save')}}><label>{t('planWork.budget.scope')}<select aria-label={t('planWork.budget.scope')} disabled={busy} value={scope} onChange={event=>{setScope(event.target.value as Scope);setConfirmed(false);setSaved(undefined)}}><option value="account">{t('planWork.budget.account')}</option><option value="owner">{t('planWork.budget.owner')}</option></select></label><WorkBudgetFields key={scope} value={policy} includeRecovery={scope==='account'} disabled={busy} onChange={next=>{dirty.current[scope]=true;setDrafts(previous=>({...previous,[scope]:next}));setConfirmed(false);setSaved(undefined)}}/>{scope==='owner'&&<p className={layout.hint}>{t('planWork.budget.ownerRecoveryBoundary')}</p>}<p className={layout.hint}>{t(increase?'planWork.budget.dynamicIncrease':'planWork.budget.lowerProtection')}</p><label className={layout.confirm}><input required type="checkbox" disabled={busy||!!pending} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{t('planWork.budget.confirm')}</label><button type="submit" disabled={busy||!confirmed||!!pending||!!api.recoveryMessage()||!isWorkBudgetPolicyValid(policy)}>{t(busy?'continuous.common.saving':'planWork.budget.save')}</button></form>}
 </details>
}
