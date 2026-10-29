import {ArrowRight} from 'lucide-react'
import {useEffect,useRef,useState} from 'react'
import {industryUpdateResourceOptions,type IndustryUpdateChoices} from '@teloa/contract'
import {industryUpdateSubmission} from './industry-update-plan.js'
import type {IndustryLocalRole,IndustryUpdateContext,IndustryUpdateDiff} from './industry-update.js'
import type {IndustryLoadRecord,IndustryLoadUpgrade,IndustryLoadUpgradeInput} from './industry-load-api.js'
import type {MarketItem} from './market-preview.js'
import css from './MarketPage.module.css'
import base from './TaskPage.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {knowledgeResetFromError,type KnowledgeResetPreview} from './knowledge-reset.js'
import {KnowledgeResetConfirmation} from './KnowledgeResetConfirmation.js'

const sections=[['relations','market.industry.update.relations'],['entrypoints','market.industry.update.entrypoints'],['positioning','market.industry.update.positioning']] as const
/**
 * 能不能按模板重放：岗位已离开目录无从重放；运行中的岗位要先暂停（宿主的既有判据，硬提交会整笔回滚）；
 * 候选模板改了岗位身份类型时同样不允许——已建立的岗位不能变更身份类型。
 */
const templateReplayable=(role:IndustryLocalRole)=>role.state!=='missing'&&role.state!=='active'&&!role.kindChanged
/**
 * 升级方案交给宿主持久化：保存即建立继任加载并固定这份选择，页面不再保留内存方案。
 * 已保存的方案从继任加载的升级血缘上读回，因此刷新后仍然可见，也不再提供撤回。
 * `record` 是宿主里的持久化加载记录，提交所需的加载身份与映射指纹一律取自它。
 */
export function IndustryUpdateForm({context,record,baseline,candidate,diff,saved,upgrade}:{context:IndustryUpdateContext;record:IndustryLoadRecord;baseline:MarketItem;candidate:MarketItem;diff:IndustryUpdateDiff;saved:IndustryLoadUpgrade|undefined;upgrade:(input:IndustryLoadUpgradeInput)=>Promise<void>}){
 const {locale,t}=useI18n(),labels={keep:t('market.industry.update.keepResource'),candidate:t('market.industry.update.useCandidate'),detach:t('market.industry.update.detach'),skip:t('market.industry.update.skip'),'keep-local':t('market.industry.update.keepLocal'),'use-template':t('market.industry.update.useTemplate')}
 const knowledgeChoices=Object.fromEntries(diff.resources.filter(row=>row.kind==='knowledge'&&row.change!=='unchanged').map(row=>[row.id,row.change==='removed'?'detach':'candidate'])) as IndustryUpdateChoices['resources']
 const [choices,setChoices]=useState<IndustryUpdateChoices>({resources:knowledgeChoices,roles:{},relations:'keep',entrypoints:'keep',positioning:'keep'})
 const [error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false)
 const [knowledgeReset,setKnowledgeReset]=useState<{key:string;input:IndustryLoadUpgradeInput;preview:KnowledgeResetPreview}>()
 const selectionKey=JSON.stringify([record.id,record.mappingHash,candidate.contentStorage?.contentId,candidate.packageContent?.hash,candidate.packageContent?.manifestPath,choices]),selection=useRef(selectionKey);selection.current=selectionKey
 useEffect(()=>{setKnowledgeReset(undefined)},[selectionKey])
 const change=(next:IndustryUpdateChoices)=>{setChoices({...next,resources:{...next.resources,...knowledgeChoices}});setConfirmed(false);setError('');setKnowledgeReset(undefined)}
 const local=diff.localRoles.filter(row=>row.fields.length)
 // 未变化的资源一律沿用旧实例，不需要也不接受选择。
 const decided=diff.resources.filter(row=>row.change!=='unchanged')
 const summary=(value:IndustryUpdateChoices)=><ul>{sections.map(([key,title])=><li key={key}>{t(title)}：{value[key]==='keep'?t('market.industry.update.keepCurrent'):t('market.industry.update.useCandidate')}</li>)}{local.map(role=><li key={role.id}>{t('market.industry.update.localChange',{name:role.name})}：{value.roles[role.id]?labels[value.roles[role.id]! ]:t('market.industry.update.unselected')}</li>)}</ul>
 const submit=async()=>{
  setBusy(true)
  try{
   if(!confirmed)throw Error()
   const input=industryUpdateSubmission(context,record,baseline,candidate,{...choices,resources:{...choices.resources,...knowledgeChoices}},crypto.randomUUID())
   try{await upgrade(input)}catch(reason){const preview=knowledgeResetFromError(reason);if(preview&&selection.current===selectionKey){setKnowledgeReset({key:selectionKey,input,preview});return}throw reason}
   setError('')
  }catch(reason){setError(localizeWorkError(locale,reason)||t('market.industry.update.saveFailed'))}
  finally{setBusy(false)}
 }
 const confirmKnowledgeReset=async()=>{
  const reset=knowledgeReset;if(!reset||reset.key!==selection.current||busy)return
  setBusy(true);setKnowledgeReset(undefined);setError('')
  try{await upgrade({...reset.input,knowledgeResetDigest:reset.preview.digest})}
  catch(reason){const preview=knowledgeResetFromError(reason);if(preview&&selection.current===reset.key)setKnowledgeReset({...reset,preview});else setError(localizeWorkError(locale,reason))}finally{setBusy(false)}
 }
 return <section className={css.sheet} aria-label={t('market.industry.update.aria')}><h3>{t('market.industry.update.title')}</h3><p>{t('market.industry.update.help')}</p>
 {saved?<><p role="status">{t('market.industry.update.saved')}</p><p>{saved.templateVersion} <ArrowRight size={12} role="img" aria-label={t('presentation.changeTo')} className={css.changeArrow}/> {candidate.version}</p>{summary(saved.choices)}<ul>{Object.entries(saved.choices.resources).map(([resourceId,choice])=><li key={resourceId}>{diff.resources.find(row=>row.id===resourceId)?.title||resourceId}：{labels[choice]}</li>)}</ul></>:<form className={base.form} onSubmit={event=>{event.preventDefault();void submit()}}>
 {decided.map(row=>row.kind==='knowledge'?<p key={row.id}>{row.title}：{labels[knowledgeChoices[row.id]!]}</p>:<label key={row.id}>{row.title}<select aria-label={t('market.industry.update.actionAria',{title:row.title})} value={choices.resources[row.id]||''} onChange={event=>change({...choices,resources:{...choices.resources,[row.id]:event.target.value as IndustryUpdateChoices['resources'][string]}})}><option value="">{t('market.industry.update.choose')}</option>{industryUpdateResourceOptions(row.change,row.kind,row.reasons).map(value=><option key={value} value={value}>{labels[value]}</option>)}</select></label>)}
 {local.map(role=><label key={role.id}>{t('market.industry.update.localChange',{name:role.name})}<select aria-label={t('market.industry.update.localActionAria',{name:role.name})} value={choices.roles[role.id]||''} onChange={event=>change({...choices,roles:{...choices.roles,[role.id]:event.target.value as IndustryUpdateChoices['roles'][string]}})}><option value="">{t('market.industry.update.choose')}</option><option value="keep-local">{labels['keep-local']}</option><option value="use-template" disabled={!templateReplayable(role)}>{labels['use-template']}</option></select></label>)}
 {local.some(role=>role.state==='active')&&<p role="status">{t('market.industry.update.pauseRoleFirst')}</p>}
 {sections.map(([key,title])=><label key={key}>{t(title)}<select aria-label={t('market.industry.update.actionAria',{title:t(title)})} value={choices[key]} onChange={event=>change({...choices,[key]:event.target.value})}><option value="keep">{t('market.industry.update.keepCurrent')}</option><option value="candidate">{t('market.industry.update.useCandidate')}</option></select></label>)}
 <h4>{t('market.industry.update.selection')}</h4>{summary(choices)}<ul>{decided.map(row=><li key={row.id}>{row.title}：{choices.resources[row.id]?labels[choices.resources[row.id]! ]:t('market.industry.update.unselected')}</li>)}</ul>
 <label className={css.check}><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{t('market.industry.update.confirm')}</label>
 {knowledgeReset?.key===selectionKey&&<KnowledgeResetConfirmation preview={knowledgeReset.preview} busy={busy} confirm={()=>void confirmKnowledgeReset()} cancel={()=>setKnowledgeReset(undefined)}/>}
 {error&&<p role="alert">{error}</p>}<button type="submit" disabled={!confirmed||busy||!!knowledgeReset||diff.sameContent||!!diff.blockers.length}>{t('market.industry.update.save')}</button>
 </form>}<p className={css.notice}>{t('market.industry.update.boundary')}</p></section>
}
