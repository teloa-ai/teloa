import {useEffect,useState} from 'react'
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
export function WorkBudgetPanel({api,budgetAccountId}:{api:WorkBudgetApi;budgetAccountId:string}){
 const {t,locale}=useI18n(),[account,setAccount]=useState<BudgetView>(),[owner,setOwner]=useState<BudgetView>(),[scope,setScope]=useState<'account'|'owner'>('account'),[policy,setPolicy]=useState<WorkBudgetPolicy>(),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[discarded,setDiscarded]=useState(false),current=scope==='account'?account:owner
 const accept=async(value:BudgetView)=>{if(value.budgetAccountId&&value.budgetAccountId!==budgetAccountId){const [a,o]=await Promise.all([api.read(budgetAccountId),api.readOwner()]);setAccount(a);setOwner(o)}else if(value.budgetAccountId)setAccount(value);else setOwner(value)}
 useEffect(()=>{let live=true;setAccount(undefined);setOwner(undefined);setError('');void Promise.all([api.read(budgetAccountId),api.readOwner()]).then(([a,o])=>{if(live){setAccount(a);setOwner(o)}},cause=>{if(live)setError(localizeWorkError(locale,cause))});return()=>{live=false}},[api,budgetAccountId,locale])
 useEffect(()=>{setPolicy(current?.policy);setConfirmed(false)},[current?.version,scope,budgetAccountId])
 const act=async(work:()=>Promise<BudgetView>)=>{if(busy)return;setBusy(true);setError('');setDiscarded(false);try{await accept(await work());setConfirmed(false)}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}
 useEffect(()=>setDiscarded(false),[api,budgetAccountId])
 const refresh=()=>act(async()=>{const [a,o]=await Promise.all([api.read(budgetAccountId),api.readOwner()]);setOwner(o);return a})
 const exhausted=exhaustion(account,owner)
 return <details className={css.block} open={exhausted?true:undefined}><summary>{t('planWork.budget.title')}</summary>{exhausted&&<p role="alert">{localizeWorkError(locale,exhausted)}</p>}<p>{t('planWork.budget.boundary')}</p>{account&&<p>{t('planWork.budget.account')}：{t('planWork.budget.used',usage(account))}</p>}{owner&&<p>{t('planWork.budget.owner')}：{t('planWork.budget.used',usage(owner))}</p>}{error&&<p role="alert">{error}</p>}{api.recoveryMessage()&&<p role="alert">{localizeWorkError(locale,api.recoveryMessage())} {t('recovery.nextStep')}</p>}{discarded&&<p role="status">{t('recovery.discarded')}</p>}{(api.pending()||api.recoveryMessage())&&<div className={css.buttons}>{api.pending()&&<><span>{t('planWork.budget.unknown')}</span><button type="button" disabled={busy||!!api.recoveryMessage()} onClick={()=>void act(()=>api.recover())}>{t('planWork.recover')}</button></>}<button type="button" disabled={busy} onClick={()=>{setDiscarded(false);try{api.discard();setConfirmed(false);setDiscarded(true)}catch(cause){setError(localizeWorkError(locale,cause))}}}>{t('recovery.discard')}</button></div>}
 <ToolbarIconButton label={t('taskExecution.refresh')} icon={RefreshCw} disabled={busy} onClick={()=>void refresh()}/>
 {current&&policy&&<form className={css.form} onSubmit={event=>{event.preventDefault();if(!confirmed||api.pending()||api.recoveryMessage()||busy)return;void act(()=>api.configure(current,policy))}}><label>{t('planWork.budget.scope')}<select disabled={busy} value={scope} onChange={event=>setScope(event.target.value as typeof scope)}><option value="account">{t('planWork.budget.account')}</option><option value="owner">{t('planWork.budget.owner')}</option></select></label>{keys.map(key=><label key={key}>{t(labels[key])}<input required type="number" min={key==='maxRetries'?0:1} step={1} disabled={busy} value={key==='maxElapsedMs'?policy[key]/60000:policy[key]} onChange={event=>{const value=Number(event.target.value);setPolicy({...policy,[key]:key==='maxElapsedMs'?value*60000:value});setConfirmed(false)}}/></label>)}<label><input required type="checkbox" disabled={busy||!!api.pending()} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{t('planWork.budget.confirm')}</label><button type="submit" disabled={busy||!confirmed||!!api.pending()||!!api.recoveryMessage()||keys.some(k=>!Number.isSafeInteger(policy[k])||policy[k]<(k==='maxRetries'?0:1))}>{t(busy?'continuous.common.saving':'planWork.budget.save')}</button></form>}
 </details>
}
