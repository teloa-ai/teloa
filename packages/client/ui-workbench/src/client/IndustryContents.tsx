import type {IndustryContent} from './industry-directory.js'
import {useMemo} from 'react'
import {IndustryResourceBrowser} from './IndustryResourceBrowser.js'
import {inspectIndustryContent,type IndustryDefinition,type IndustryInspection} from './industry-content.js'
import {type IndustryManifest,type IndustryResource} from './industry-manifest.js'
import {useI18n} from './i18n/provider.js'
import type {TeloaTranslate} from './i18n/index.js'
import css from './MarketPage.module.css'
import {industryResourceDestinationGroups,localizedIndustryResourceTitle} from './industry-template-presentation.js'
import {resolveMarketLocalizedMetadata} from './market-locale-metadata.js'
import {localizedBusinessActionTitle,localizedBusinessFieldLabel,localizedBusinessObjectType,localizedBusinessViewTitle} from './business-definition-localization.js'
const inspectionLabel=(t:TeloaTranslate,state:IndustryInspection['state']|undefined)=>t(`market.industry.inspection.${state??'unread'}` as Parameters<TeloaTranslate>[0])

export function IndustryContents({manifest,content,persisted=false}:{manifest:IndustryManifest;content:IndustryContent|undefined;persisted?:boolean}){
 const {locale,t}=useI18n()
 const resources=manifest.resources.map(resource=>({...resource,title:localizedIndustryResourceTitle(resource,locale)}))
 const byId=new Map(resources.map(resource=>[resource.id,resource]))
 const inspections=useMemo(()=>new Map((content?inspectIndustryContent(manifest,content):[]).map(row=>[row.id,row])),[manifest,content])
 const inspectionRows=[...inspections.values()]
 const destinations=industryResourceDestinationGroups.map(row=>({key:row.key,count:manifest.resources.filter(resource=>row.kinds.includes(resource.kind)).length}))
 const relations={ 'role-knowledge':t('market.industry.relation.knowledge'),'role-skill':t('market.industry.updatePreview.relation.skill'),'role-connection':t('market.industry.relation.connection'),'role-work':t('market.industry.relation.work')} as const
 return <section className={css.industryContents} aria-label={t('market.industry.contents.aria')}>
  <header className={css.resourceHeader}><div><span className={css.eyebrow}>{t('market.industry.contents.eyebrow')}</span><h3>{t('market.industry.contents.count',{count:manifest.resources.length})}</h3></div><p>{t('market.industry.contents.help')}</p></header>
  {content&&<p className={css.resourceStatus} role="status">{t('market.industry.contents.readStatus',{ready:inspectionRows.filter(row=>row.state==='parsed').length,issues:inspectionRows.filter(row=>row.state==='missing'||row.state==='invalid').length,pending:inspectionRows.filter(row=>row.state==='unresolved').length})} {persisted?t('market.industry.contents.persisted'):t('market.industry.contents.notPersisted')}</p>}
  {!content&&<p className={css.resourceStatus} role="status">{t('market.industry.contents.unread')}</p>}
  <section className={css.resourceDestinations} aria-label={t('market.industry.destination.aria')}><header><strong>{t('market.industry.destination.title')}</strong><span>{t('market.industry.destination.help')}</span></header><ul>{destinations.map(row=><li key={row.key}><span>{t(row.key as Parameters<TeloaTranslate>[0])}</span><strong>{t('market.industry.contents.count',{count:row.count})}</strong></li>)}</ul></section>
  <IndustryResourceBrowser resources={resources} status={resource=>inspectionLabel(t,inspections.get(resource.id)?.state)} render={resource=>{
   const inspection=inspections.get(resource.id),links=manifest.relations.filter(link=>link.from===resource.id||link.to===resource.id)
   return <><ResourceContent inspection={inspection} title={resource.title}/><dl><dt>{t('market.industry.contents.required')}</dt><dd>{resource.required?t('market.industry.contents.requiredYes'):t('market.industry.contents.requiredNo')}</dd><dt>{t('market.catalog.source')}</dt><dd>{resource.source.kind==='local'?t('market.industry.source.bundled'):t('market.industry.source.public',{version:resource.source.version})}</dd>{manifest.entrypoints.includes(resource.id)&&<><dt>{t('market.industry.contents.entrypoint')}</dt><dd>{t('market.industry.contents.entrypointHelp')}</dd></>}</dl><h4>{resource.kind==='role'?t('market.industry.contents.collaboration'):t('market.industry.contents.relatedRoles')}</h4>{links.length?<ul>{links.map(link=><li key={link.kind+':'+link.from+':'+link.to}>{link.from===resource.id?relations[link.kind]+'：'+byId.get(link.to)?.title:byId.get(link.from)?.title}</li>)}</ul>:<p>{t('market.industry.contents.noRelations')}</p>}<details><summary>{t('market.industry.contents.resourceInfo')}</summary><p>{t('market.industry.contents.resourceId',{id:resource.id})}</p><p>{resource.source.kind==='local'?t('market.industry.contents.templatePath',{path:resource.source.path}):t('market.industry.contents.publicResource',{id:resource.source.id,version:resource.source.version})}</p></details></>
  }}/>
 </section>
}

function ResourceContent({inspection,title}:{inspection:IndustryInspection|undefined;title:string}){
 const {t,locale}=useI18n()
 if(!inspection)return <p>{t('market.industry.contents.contentUnread')}</p>
 const definition=inspection.definition
 const trigger=definition?.kind==='plan'?(definition.trigger.kind==='event'?t('continuous.trigger.event',{source:definition.trigger.source,event:definition.trigger.event}):definition.trigger.cadence==='daily'?t('continuous.trigger.daily',{time:definition.trigger.time,timezone:definition.trigger.timezone}):t('continuous.trigger.weekly',{weekday:String(definition.trigger.weekday),time:definition.trigger.time,timezone:definition.trigger.timezone})):''
 const work=definition?.kind==='work-template'?definition.manifest:undefined
 const localize=(metadata:import('@teloa/contract').LocalizedMetadata|undefined,original:string)=>resolveMarketLocalizedMetadata(metadata??{original,defaultLocale:'und',locales:{}},locale).value
 return <><p role={inspection.state==='invalid'?'alert':undefined}>{inspection.message}</p>{definition&&(definition.kind==='skill'||definition.kind==='knowledge'?<details><summary>{t('market.industry.contents.preview',{type:definition.kind==='skill'?t('market.industry.resource.skill'):t('market.industry.resource.knowledge'),title})}</summary><pre>{definition.text}</pre>{definition.kind==='skill'&&<><p>{t('market.industry.contents.files',{count:definition.files.length})}</p><ul>{definition.files.map(file=><li key={file.path}>{file.path} · {file.size} {t('market.skill.file.bytes')}</li>)}</ul></>}</details>:work?<section><h4>{t('market.industry.contents.method')}</h4><p>{localize(work.localized?.description,work.description)}</p><ul>{work.requirements.map((value,index)=><li key={index}>{localize(work.localized?.requirements?.[index],value)}</li>)}</ul><p>{t('market.industry.contents.delivery',{value:localize(work.localized?.output,work.output)})}</p></section>:definition.kind==='plan'?<dl><dt>{t('market.industry.contents.planName')}</dt><dd>{definition.title}</dd><dt>{t('market.industry.contents.trigger')}</dt><dd>{trigger}</dd><dt>{t('market.industry.contents.dataScope')}</dt><dd>{definition.dataScope}</dd><dt>{t('market.industry.contents.taskTemplate')}</dt><dd>{definition.workTemplate}</dd></dl>:definition.kind==='object-type'||definition.kind==='business-view'||definition.kind==='business-action'?<BusinessDeclaration definition={definition}/>:definition.kind==='business-configuration'?<section><h4>{definition.definition.configuration.title}</h4><ul>{definition.definition.configuration.pages.map(page=><li key={page.id}>{page.title}</li>)}</ul></section>:definition.kind==='role'?<dl><dt>{t('market.industry.contents.roleName')}</dt><dd>{definition.fields.name}</dd><dt>{t('market.industry.contents.identity')}</dt><dd>{definition.fields.kind==='employee'?t('market.industry.contents.employee'):t('market.industry.contents.twin')}</dd><dt>{t('market.industry.contents.duty')}</dt><dd>{definition.fields.duty}</dd><dt>{t('market.industry.contents.readableData')}</dt><dd>{definition.fields.dataScope}</dd><dt>{t('market.industry.contents.executableWork')}</dt><dd>{definition.fields.executionScope}</dd></dl>:null)}</>
}

/**
 * 三类业务声明的结构摘要（规格 §7.3）：只写这份声明**长什么样**，一个取值样例都不写。
 *
 * 逐条说明哪些字段被刻意漏掉，别当成抄漏：
 * - 字段清单只列 `label` 与类型名。`from` 是接收方快照里的字段标签、`values` 是枚举的真实取值，
 *   两项都是别人业务数据的形状与取值面，进了预览等于替对方把数据字典公开了一遍。
 * - 视图只给形态、图形、看哪类对象与度量 / 筛选的**条数**：度量的 `where`、筛选的 `values`
 *   里全是字面量取值，展开就把取值样例带出来了。时间窗是封闭枚举，可以给人话。
 * - 动作不列 `from:'literal'` 的取值（声明作者写进包里的固定文字，往往含内部口径），
 *   只给输入项数，再加一句固定说明——`inputs.length` 与接收方任务模板 `requirements.length`
 *   必须相等，不等时读取层会把这个动作整条丢掉（`business-definition-source.ts` 的核对 2/4），
 *   这句话是本层唯一能提前说清这件事的地方（T1 报告 concern 2）。
 *
 * 全部走 `dl` / `ul` 文本节点：`<pre>` 打原文就是把整份 JSON 摊开，与本摘要的目的正相反。
 */
/** 市场详情与本地分享预览共用同一份脱敏结构摘要，避免两处展示口径漂移。 */
export function BusinessDeclaration({definition}:{definition:Extract<IndustryDefinition,{kind:'object-type'}|{kind:'business-view'}|{kind:'business-action'}>}){
 const {t,locale}=useI18n()
 const enumLabel=(value:string)=>t(value as Parameters<TeloaTranslate>[0])
 const count=(value:number)=>t('market.industry.contents.count',{count:value})
 if(definition.kind==='object-type'){
  const value=definition.definition
  const copy=localizedBusinessObjectType(value,locale)
  return <section><dl>
   <dt>{t('market.industry.business.objectType.title')}</dt><dd>{copy.title}</dd>
   <dt>{t('market.industry.business.objectType.unit')}</dt><dd>{copy.unit}</dd>
   <dt>{t('market.industry.business.objectType.fieldCount')}</dt><dd>{count(value.fields.length)}</dd>
   <dt>{t('market.industry.business.objectType.source')}</dt><dd>{value.sourceId}</dd>
   {value.defaultAction!==undefined&&<><dt>{t('market.industry.business.objectType.defaultAction')}</dt><dd>{value.defaultAction}</dd></>}
  </dl><h4>{t('market.industry.business.fields')}</h4><ul>
   {value.fields.map(field=><li key={field.name}>{localizedBusinessFieldLabel(field,locale)} · {enumLabel('market.industry.business.fieldType.'+field.type)}</li>)}
  </ul></section>
 }
 if(definition.kind==='business-view'){
  const value=definition.definition
  return <dl>
   <dt>{t('market.industry.business.title')}</dt><dd>{localizedBusinessViewTitle(value,locale)}</dd>
   <dt>{t('market.industry.business.view.kind')}</dt><dd>{enumLabel('market.industry.business.viewKind.'+value.kind)}</dd>
   <dt>{t('market.industry.business.view.chart')}</dt><dd>{enumLabel('market.industry.business.chart.'+value.chart)}</dd>
   <dt>{t('market.industry.business.view.objectType')}</dt><dd>{value.objectType}</dd>
   <dt>{t('market.industry.business.view.measures')}</dt><dd>{count(value.measures.length)}</dd>
   <dt>{t('market.industry.business.view.filters')}</dt><dd>{count(value.filters.length)}</dd>
   {value.window!==undefined&&<><dt>{t('market.industry.business.view.window')}</dt><dd>{enumLabel('market.industry.business.window.'+value.window.relative)}</dd></>}
  </dl>
 }
 const value=definition.definition
 // 两种目标都要落到一个任务模板标识上：`work-template` 直接是 `localId`，`execution-tool` 的记录模板写在 `workTemplate`。
 const workTemplate=value.target.kind==='work-template'?value.target.localId:value.target.workTemplate
 return <section><dl>
  <dt>{t('market.industry.business.title')}</dt><dd>{localizedBusinessActionTitle(value,locale)}</dd>
  <dt>{t('market.industry.business.action.objectType')}</dt><dd>{value.objectType}</dd>
  <dt>{t('market.industry.business.action.target')}</dt><dd>{enumLabel('market.industry.resource.'+value.target.kind)}</dd>
  <dt>{t('market.industry.business.action.workTemplate')}</dt><dd>{workTemplate}</dd>
  <dt>{t('market.industry.business.action.inputs')}</dt><dd>{count(value.inputs.length)}</dd>
 </dl><p>{t('market.industry.business.action.inputsNote',{count:value.inputs.length})}</p></section>
}
