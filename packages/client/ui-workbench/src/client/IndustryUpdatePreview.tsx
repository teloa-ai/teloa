import {isIndustryManifest} from './industry-manifest.ts'
import {useState} from 'react'
import {IndustryUpdateForm} from './IndustryUpdateForm.js'
import type {IndustryLoadRecord,IndustryLoadUpgradeInput} from './industry-load-api.js'
import {compareIndustryUpdate, type IndustryUpdateContext, type IndustryUpdateDiff} from './industry-update.js'
import type {MarketItem} from './market-preview.js'
import type {BusinessScopeLabel} from './business-directory.js'
import type {IndustryResourceKind} from './industry-manifest.js'
import {roleStates} from './role-preview.js'
import {triggerLabel} from './continuous-preview.js'
import {useI18n} from './i18n/provider.js'
import css from './MarketPage.module.css'

/** `loads` 是宿主里已持久化的加载记录：升级要提交到它上面，已保存的方案也从继任加载上读回。 */
export type IndustryReviewProps={loads:readonly IndustryLoadRecord[];upgrade:(input:IndustryLoadUpgradeInput)=>Promise<void>;rolesReady:boolean;rolesFailed:boolean;refreshRoles:()=>void;context:IndustryUpdateContext;open:(kind:'role'|'task'|'plan',id:string)=>void}

const changeKeys={
  added:'market.industry.updatePreview.change.added',
  removed:'market.industry.updatePreview.change.removed',
  changed:'market.industry.updatePreview.change.changed',
  unchanged:'market.industry.updatePreview.change.unchanged',
} as const
const relationKeys={
  'role-knowledge':'market.industry.updatePreview.relation.knowledge',
  'role-skill':'market.industry.updatePreview.relation.skill',
  'role-connection':'market.industry.updatePreview.relation.connection',
  'role-work':'market.industry.updatePreview.relation.work',
} as const
const fieldKeys={
  name:'market.industry.updatePreview.field.name',
  kind:'market.industry.updatePreview.field.kind',
  duty:'market.industry.updatePreview.field.duty',
  dataScope:'market.industry.updatePreview.field.dataScope',
  executionScope:'market.industry.updatePreview.field.executionScope',
  scopes:'market.industry.updatePreview.field.scopes',
  skills:'market.industry.updatePreview.field.skills',
  knowledge:'market.industry.updatePreview.field.knowledge',
  missing:'market.industry.updatePreview.field.missing',
} as const
const resourceKindKeys:Record<IndustryResourceKind,`market.industry.resource.${IndustryResourceKind}`>={
  role:'market.industry.resource.role',
  skill:'market.industry.resource.skill',
  knowledge:'market.industry.resource.knowledge',
  mcp:'market.industry.resource.mcp',
  plugin:'market.industry.resource.plugin',
  'execution-tool':'market.industry.resource.execution-tool',
  'data-source':'market.industry.resource.data-source',
  'work-template':'market.industry.resource.work-template',
  plan:'market.industry.resource.plan',
  'object-type':'market.industry.resource.object-type',
  'business-view':'market.industry.resource.business-view',
  'business-action':'market.industry.resource.business-action',
  'business-configuration':'market.industry.resource.business-configuration',
}

export function IndustryUpdatePreview({item,items,spaces,context,open,loads:records,upgrade,rolesReady,rolesFailed,refreshRoles}:{item:MarketItem;items:readonly MarketItem[];spaces:readonly BusinessScopeLabel[]}&IndustryReviewProps){
  const {t}=useI18n()
  const [loadId,setLoadId]=useState('')
  const [candidateId,setCandidateId]=useState(item.id)
  const manifest=item.manifest
  if(!isIndustryManifest(manifest))return null

  const compatible=(source:MarketItem)=>isIndustryManifest(source.manifest)&&source.manifest.id===manifest.id&&source.manifest.domain===manifest.domain&&source.manifest.scope===manifest.scope&&!!source.packageContent
  // 加载记录与基线内容一律按身份对上：加载行记着内容身份与摘要，目录条目里正是同一份内容。
  const baselineOf=(load:IndustryLoadRecord)=>items.find(row=>row.contentStorage?.contentId===load.contentId&&row.packageContent?.hash===load.contentHash&&compatible(row))
  const loads=records.filter(load=>load.templateId===manifest.id&&load.domain===manifest.domain&&load.scope===manifest.scope&&!!baselineOf(load))
  if(!loads.length)return null

  const selected=loads.find(row=>row.id===loadId)
  const baseline=selected&&baselineOf(selected)
  const candidate=items.find(row=>row.id===candidateId)
  const resourceName=(id:string,change:keyof typeof changeKeys)=>{
    const source=change==='removed'?baseline:candidate
    return isIndustryManifest(source?.manifest)?source.manifest.resources.find(row=>row.id===id)?.title||id:id
  }
  let diff:IndustryUpdateDiff|undefined
  let error=''
  if(selected){
    try{
      if(!baseline||!candidate)throw Error()
      diff=compareIndustryUpdate(context,selected,baseline,candidate)
    }catch{
      error=t('market.industry.updatePreview.compareFailed')
    }
  }
  const changed=(value:boolean)=>t(value?'market.industry.updatePreview.changedYes':'market.industry.updatePreview.changedNo')
  // 已执行的升级方案按身份读回，不靠内容摘要或空间 scope 猜：选中的加载本身就是这份候选内容的继任加载时，
  // 它自带的那段血缘就是那次方案。身份比较与 `compareIndustryUpdate` 一样用严格相等，不做大小写归一。
  // （"血缘指回选中加载"的另一支在默认目录下不可达：被替代的加载不在 `list()` 里。）
  const saved=selected?.upgrade&&candidate?.contentStorage?.contentId===selected.contentId?selected.upgrade:undefined

  return <section className={css.sheet} aria-label={t('market.industry.updatePreview.aria')}>
    <h3>{t('market.industry.updatePreview.title')}</h3>
    <p>{t('market.industry.updatePreview.description')}</p>
    <label>{t('market.industry.updatePreview.workspaceLabel')}
      <select aria-label={t('market.industry.updatePreview.workspaceAria')} value={loadId} onChange={event=>setLoadId(event.target.value)}>
        <option value="">{t('market.industry.updatePreview.workspacePlaceholder')}</option>
        {loads.map(load=><option key={load.id} value={load.id}>{spaces.find(label=>label.scope===load.space.scope)?.title||load.templateTitle||load.space.scope} · {load.templateVersion} · {load.id}</option>)}
      </select>
    </label>
    <label>{t('market.industry.updatePreview.candidateLabel')}
      <select aria-label={t('market.industry.updatePreview.candidateAria')} value={candidateId} onChange={event=>setCandidateId(event.target.value)}>
        {items.filter(compatible).map(source=><option key={source.id} value={source.id}>{source.title} · {source.version} · {source.packageContent!.hash.slice(0,12)}</option>)}
      </select>
    </label>
    {error&&<p role="alert">{error}</p>}
    {diff&&<>
      <p>{t('market.industry.updatePreview.versionSummary',{baseline:baseline!.version,candidate:candidate!.version,result:t(diff.sameContent?'market.industry.updatePreview.sameContent':'market.industry.updatePreview.differentContent')})}</p>
      <details>
        <summary>{t('market.industry.updatePreview.sourceSummary')}</summary>
        <p>{t('market.industry.updatePreview.baselineHash',{hash:selected!.contentHash})}</p>
        <p>{t('market.industry.updatePreview.candidateHash',{hash:candidate!.packageContent!.hash})}</p>
      </details>
      <p>{t('market.industry.updatePreview.sectionChanges',{positioning:changed(diff.positioningChanged),relations:changed(diff.relationsChanged),entrypoints:changed(diff.entrypointsChanged)})}</p>
      {diff.relationChanges.length>0&&<section aria-label={t('market.industry.updatePreview.relationAria')}>
        <h4>{t('market.industry.updatePreview.relationTitle')}</h4>
        <ul>{diff.relationChanges.map(row=><li key={row.change+row.kind+row.from+row.to}>{t('market.industry.updatePreview.relationLine',{change:t(changeKeys[row.change]),from:resourceName(row.from,row.change),relation:relationKeys[row.kind as keyof typeof relationKeys]?t(relationKeys[row.kind as keyof typeof relationKeys]):row.kind,to:resourceName(row.to,row.change)})}</li>)}</ul>
      </section>}
      {diff.entrypointChanges.length>0&&<section aria-label={t('market.industry.updatePreview.entrypointAria')}>
        <h4>{t('market.industry.updatePreview.entrypointTitle')}</h4>
        <ul>{diff.entrypointChanges.map(row=><li key={row.change+row.id}>{t('market.industry.updatePreview.entrypointLine',{change:t(changeKeys[row.change]),name:resourceName(row.id,row.change)})}</li>)}</ul>
      </section>}
      <p>{t('market.industry.updatePreview.resourceCounts',{added:diff.resources.filter(row=>row.change==='added').length,changed:diff.resources.filter(row=>row.change==='changed').length,removed:diff.resources.filter(row=>row.change==='removed').length})}</p>
      {diff.resources.map(row=><div className={css.component} key={row.id}>
        <strong>{t('market.industry.updatePreview.resourceTitle',{title:row.title,change:t(changeKeys[row.change])})}</strong>
        <span>{t(resourceKindKeys[row.kind as IndustryResourceKind])} · {row.id}{row.reasons.length?' · '+row.reasons.join(' · '):''}</span>
        {(row.before?.definition?.kind==='knowledge'||row.after?.definition?.kind==='knowledge')&&row.change!=='unchanged'&&<details>
          <summary>{t('market.industry.updatePreview.knowledgeCompare',{title:row.title})}</summary>
          <h4>{t('market.industry.updatePreview.loadedVersion')}</h4>
          <pre>{row.before?.definition?.kind==='knowledge'?row.before.definition.text:t('market.industry.updatePreview.noParsedBody')}</pre>
          <h4>{t('market.industry.updatePreview.candidateVersion')}</h4>
          <pre>{row.after?.definition?.kind==='knowledge'?row.after.definition.text:t('market.industry.updatePreview.noParsedBody')}</pre>
        </details>}
      </div>)}
      {diff.blockers.length>0&&<div role="alert"><strong>{t('market.industry.updatePreview.blockersTitle')}</strong><ul>{diff.blockers.map(text=><li key={text}>{text}</li>)}</ul></div>}
      {diff.pending.length>0&&<details><summary>{t('market.industry.updatePreview.pendingCount',{count:diff.pending.length})}</summary><ul>{diff.pending.map(text=><li key={text}>{text}</li>)}</ul></details>}
      {/* 岗位现状读不出来时给出重试出口：否则「正在读取岗位现状」会永久停在那里，升级入口也永远不出现。 */}
      {!rolesReady?(rolesFailed
        ?<p role="alert">{t('market.industry.updatePreview.rolesFailed')}<button type="button" onClick={refreshRoles}>{t('market.industry.updatePreview.rolesRetry')}</button></p>
        :<p role="status">{t('market.industry.updatePreview.rolesPending')}</p>):<>
      <h4>{t('market.industry.updatePreview.localWorkTitle')}</h4>
      <p>{t('market.industry.updatePreview.localWorkDescription')}</p>
      {diff.localRoles.map(role=><div className={css.component} key={role.id}>
        <strong>{role.name} · {role.state==='missing'?t('role.state.missing'):t(roleStates[role.state as keyof typeof roleStates])}</strong>
        <span>{role.fields.length?t('market.industry.updatePreview.localChanges',{fields:role.fields.map(field=>fieldKeys[field as keyof typeof fieldKeys]?t(fieldKeys[field as keyof typeof fieldKeys]):field).join(' · ')}):t('market.industry.updatePreview.loadedDefinition')}</span>
        {role.kindChanged&&<span role="status">{t('market.industry.updatePreview.roleKindChanged')}</span>}
        {role.roleId&&<button type="button" onClick={()=>open('role',role.roleId!)}>{t('market.industry.updatePreview.viewRole',{name:role.name})}</button>}
      </div>)}
      <p>{t('market.industry.updatePreview.relatedCounts',{tasks:diff.tasks.length,plans:diff.plans.length})}</p>
      {diff.tasks.map(task=><button key={task.id} type="button" onClick={()=>open('task',task.id)}>{t('market.industry.updatePreview.viewTask',{title:task.title})}</button>)}
      {diff.plans.map(plan=><div className={css.component} key={plan.id}>
        <strong>{plan.fields.title}</strong>
        <span>{t(plan.archived?'market.industry.updatePreview.planArchived':plan.enabled?'market.industry.updatePreview.planEnabled':'market.industry.updatePreview.planPaused')} · {triggerLabel(plan.fields.trigger,t)} · {t('market.industry.updatePreview.planRevision',{revision:plan.revision})}</span>
        {plan.revision>1&&<span>{t('market.industry.updatePreview.planAdjusted')}</span>}
        <button type="button" onClick={()=>open('plan',plan.id)}>{t('market.industry.updatePreview.viewPlan',{title:plan.fields.title})}</button>
      </div>)}
      <IndustryUpdateForm key={loadId+candidateId} context={context} record={selected!} baseline={baseline!} candidate={candidate!} diff={diff} saved={saved} upgrade={upgrade}/>
      </>}
    </>}
  </section>
}
