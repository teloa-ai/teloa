import type {MarketFunctionKey} from '@teloa/contract'
import {isIndustryManifest} from './industry-manifest.ts'
import type {AtomicSkillContent} from './atomic-skill.ts'
import {localizedMetadata,isIndustryPackageFormat,type LocalizedMetadata,type LocalizedMetadataResolution} from '@teloa/contract'
import {resolveMarketLocalizedMetadata} from './market-locale-metadata.ts'
import { validateIndustryManifest, type IndustryLocalizedMetadata, type IndustryManifest, type IndustryResourceKind } from './industry-manifest.ts'
import type { IndustryContent } from './industry-directory.ts'
import { freezeMarketTarget, marketTargetKey, type MarketTargetRef, type MarketTarget } from './market-target.ts'
import { builtinIndustryManifests } from './builtin-industry-manifests.ts'
import type {MarketPluginRegistrySource} from '@teloa/contract'
import type {TeloaTranslate} from './i18n/index.ts'
export const marketKinds={template:'任务模板',bundle:'行业模板',role:'员工',skill:'技能',resource:'连接与知识'} as const
export const marketVisibility={public:'公共',team:'团队',personal:'本人'} as const
export type MarketKind=keyof typeof marketKinds
export type MarketSource={kind:'builtin'}|{kind:'created'}|{kind:'paste'}|{kind:'upload';name:string;size:number}|{kind:'stored';contentId:string}|{kind:'github';url:string;revision:string}|{kind:'conversation';request:string}|{kind:'catalog';entryId:string;version:string}
export type WorkTemplateLocalizedMetadata=IndustryLocalizedMetadata&{requirements?:LocalizedMetadata[];output?:LocalizedMetadata}
export type ManifestBase={id:string;title:string;version:string;domain:string;description:string;localized?:WorkTemplateLocalizedMetadata;requirements:string[];output:string}
export type MarketManifest=IndustryManifest|ManifestBase&({format:'teloa.work-template/v1';skills:{id:string;title:string;version:string}[]}|{format:'teloa.business-package/v1';components:{kind:'skill'|'mcp'|'plugin'|'work-template'|'role';path:string;required:boolean}[]})
export type ParsedManifest={manifest:MarketManifest;hash:string;raw:string}
export type MarketTrust={publisher:string;repository:{host:'github.com';owner:string;repo:string}|null;license:{status:'declared';value:string}|{status:'missing'};signature:{status:'verified'|'unverified'|'invalid';signer:string|null};compatibility:{teloa:string;dsh:string};plugins:{id:string;version:string;required:boolean}[];externalCapabilities:{id:string;kind:'mcp'|'connection';required:boolean}[];permissions:{id:string;description:string;required:boolean}[];review:{conclusion:'approved'|'needs-review'|'rejected';summary:string}}
export type MarketItemLocalized={title?:LocalizedMetadata;summary?:LocalizedMetadata;requirements?:LocalizedMetadata[];output?:LocalizedMetadata;author?:LocalizedMetadata;license?:LocalizedMetadata;compatibility?:LocalizedMetadata;components?:{name:LocalizedMetadata;status:LocalizedMetadata}[]}
/** `functions`：功能分类（市场分类定案 9 类 + 其他），只在本人创建时选了分类才有；没有即「未分类」，Teloa 自带内容的分类见 builtin-market-taxonomy.ts。 */
export type MarketItem={functions?:MarketFunctionKey[];contentStorage?:{contentId:string;createdAt:string;loaded:boolean};atomicSkill?:AtomicSkillContent;resourceKind?:IndustryResourceKind;capabilityCategories?:string[];installationState?:'not-installed';packageContent?:IndustryContent;trust?:MarketTrust;localized?:MarketItemLocalized;pluginInstallSource?:MarketPluginRegistrySource;id:string;kind:MarketKind;title:string;version:string;scope:string;visibility:keyof typeof marketVisibility;summary:string;requirements:string[];output:string;author:string;license:string;source:MarketSource;protocol?:string;owner:'DSH'|'Teloa';compatibility:string;components:{name:string;required:boolean;status:string}[];manifest?:MarketManifest;hash?:string;raw?:string}
export type MarketIntent={id:string;version:number;itemId:string;itemVersion:string;scope:string;target:string;targetRef?:MarketTargetRef;purpose:string;visibility:'personal'|'team';status:'draft'|'withdrawn';createdAt:string;updatedAt:string;sessionId?:string;preparation?:{status:'pending'|'failed'|'ready';message:string}|undefined}
export type MarketState={items:MarketItem[];intents:MarketIntent[]}
export const MAX_MANIFEST_BYTES=1024*1024
const text=(value:unknown,label:string,max=2000):string=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(label+'必须填写且不超过 '+max+' 字。');return value.trim()}
const object=(value:unknown,keys:string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('清单字段必须是对象。');for(const key of Object.keys(value))if(!keys.includes(key))throw Error('清单含未知字段：'+key);return value as Record<string,unknown>}
const list=(value:unknown,label:string,min=0):unknown[]=>{if(!Array.isArray(value)||value.length<min||value.length>100)throw Error(label+'需要 '+min+' 至 100 项。');return value}
export function validateManifest(raw:unknown):MarketManifest{
  if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&isIndustryPackageFormat(Reflect.get(raw,'format')))return validateIndustryManifest(raw)
  const value=object(raw,['format','id','title','version','domain','description','localized','requirements','output','skills','components'])
  if(value.format!=='teloa.work-template/v1'&&value.format!=='teloa.business-package/v1')throw Error('不支持此清单格式；生态扩展须由对应的适配程序解析。')
  object(value,['format','id','title','version','domain','description','localized','requirements','output',value.format==='teloa.work-template/v1'?'skills':'components'])
  const base:ManifestBase={id:text(value.id,'标识',100),title:text(value.title,'名称',120),version:text(value.version,'版本',60),domain:text(value.domain,'业务',80),description:text(value.description,'工作目标'),requirements:list(value.requirements,'输入要求',1).map(item=>text(item,'输入要求',500)),output:text(value.output,'交付要求')}
  if(value.localized!==undefined){
    const localizedRow=object(value.localized,['title','description','requirements','output']),localized:WorkTemplateLocalizedMetadata={}
    for(const field of ['title','description'] as const)if(localizedRow[field]!==undefined){
      const metadata=localizedMetadata(localizedRow[field])
      if(metadata.original!==base[field])throw Error('本地化元数据的稳定原文必须与清单字段一致。')
      localized[field]=metadata
    }
    if(localizedRow.requirements!==undefined){
      if(!Array.isArray(localizedRow.requirements)||localizedRow.requirements.length!==base.requirements.length)throw Error('输入要求本地化元数据必须与清单逐项对应。')
      localized.requirements=localizedRow.requirements.map((input,index)=>{const metadata=localizedMetadata(input);if(metadata.original!==base.requirements[index])throw Error('输入要求本地化元数据的稳定原文必须与清单字段一致。');return metadata})
    }
    if(localizedRow.output!==undefined){const metadata=localizedMetadata(localizedRow.output);if(metadata.original!==base.output)throw Error('交付要求本地化元数据的稳定原文必须与清单字段一致。');localized.output=metadata}
    base.localized=localized
  }
  if(!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(base.id))throw Error('标识只允许字母、数字与连字符。')
  if(value.format==='teloa.work-template/v1')return {...base,format:value.format,skills:list(value.skills,'技能引用').map(item=>{const ref=object(item,['id','title','version']);return {id:text(ref.id,'技能标识',120),title:text(ref.title,'技能名称',120),version:text(ref.version,'技能版本',60)}})}
  return {...base,format:value.format,components:list(value.components,'组件',1).map(item=>{
    const component=object(item,['kind','path','required'])
    if(!['skill','mcp','plugin','work-template','role'].includes(component.kind as string))throw Error('不支持的组件类型。')
    const path=text(component.path,'组件路径',300)
    if(path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:?%#\u0000-\u001f\u007f]/.test(path))throw Error('组件路径必须为安全的包内相对路径。')
    if(typeof component.required!=='boolean')throw Error('组件 required 必须是布尔值。')
    return {kind:component.kind as 'skill'|'mcp'|'plugin'|'work-template'|'role',path,required:component.required}
  })}
}
export async function parseMarketManifest(raw:string):Promise<ParsedManifest>{
  const bytes=new TextEncoder().encode(raw)
  if(bytes.length>MAX_MANIFEST_BYTES)throw Error('清单大小不能超过 1 MiB。')
  let value:unknown;try{value=JSON.parse(raw)}catch{throw Error('JSON 格式无效。')}
  const manifest=validateManifest(value),digest=await crypto.subtle.digest('SHA-256',bytes)
  return {manifest,raw,hash:Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')}
}
export function githubSource(value:string,revision:string):MarketSource{
  try{const url=new URL(value.trim()),parts=url.pathname.split('/').filter(Boolean)
    if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||url.port||url.search||url.hash||parts.length<2||!parts.every(part=>/^[\w.\-]+$/.test(part)&&part!=='.'&&part!=='..'))throw Error()
    return {kind:'github',url:url.href,revision:revision.trim()}
  }catch{throw Error('请使用不含认证或查询参数的 HTTPS GitHub 仓库地址。')}
}
export function sourceLabel(source:MarketSource,t?:TeloaTranslate):string{
  if(!t)return source.kind==='builtin'?'Teloa 内置示例':source.kind==='created'?'本人创建的定义':source.kind==='paste'?'粘贴的清单':source.kind==='upload'?source.name+' · '+source.size+' 字节':source.kind==='stored'?'本人已保存内容 · '+source.contentId:source.kind==='github'?source.url+' · '+(source.revision||'版本待确认'):source.kind==='catalog'?'Teloa 官方目录 · '+source.entryId+'@'+source.version:'会话需求 · '+source.request
  if(source.kind==='builtin')return t('market.source.builtin')
  if(source.kind==='created')return t('market.source.created')
  if(source.kind==='paste')return t('market.source.paste')
  if(source.kind==='upload')return t('market.source.upload',{name:source.name,size:source.size})
  if(source.kind==='stored')return t('market.source.stored',{id:source.contentId})
  if(source.kind==='github')return t('market.source.github',{url:source.url,revision:source.revision||t('market.source.revisionPending')})
  if(source.kind==='catalog')return t('market.source.catalog',{id:source.entryId+'@'+source.version})
  return t('market.source.conversation',{request:source.request})
}
// 官方目录审核说明原文进 trustHash（backend/src/market/official-catalog.ts），存储不改；展示时把旧说法换成白话（docs-site/reference/glossary.md）
const reviewSummaryWording:readonly (readonly [string,string])[]=[['机器固定收录','自动收录'],['核验摘要','核验校验值'],['；上游 ','；原作者 ']]
const plainReviewSummary=(summary:string)=>reviewSummaryWording.reduce((text,[from,to])=>text.split(from).join(to),summary)
export function marketTrustPreview(item:MarketItem,t?:TeloaTranslate){
  const label=(key:Parameters<TeloaTranslate>[0],fallback:string)=>t?t(key):fallback
  const bundledSkills=item.components.filter(component=>/\bskill\b/i.test(component.name)).map(component=>component.name),skills=[...new Set(item.kind==='skill'?[item.title+' @'+item.version]:bundledSkills)],trust=item.trust
  if(!trust)return {publisher:item.author,license:item.license,signature:label('market.trust.unspecified','未注明'),compatibility:item.compatibility,review:label('market.trust.unstructuredReview','待审查 · 未提供结构化的来源说明'),skills,plugins:[],connections:[],permissions:[],installable:false}
  const optional=(required:boolean)=>label(required?'market.trust.required':'market.trust.optional',required?'（必需）':'（可选）')
  const signature=trust.signature.status==='verified'?label('market.trust.signature.verified','已验证'):trust.signature.status==='unverified'?label('market.trust.signature.unverified','未验证'):label('market.trust.signature.invalid','签名无效')
  const review=trust.review.conclusion==='approved'?label('market.trust.review.approved','已审查'):trust.review.conclusion==='needs-review'?label('market.trust.review.pending','待审查'):label('market.trust.review.rejected','已拒绝')
  return {publisher:trust.publisher+(trust.repository?' · '+trust.repository.host+'/'+trust.repository.owner+'/'+trust.repository.repo:''),license:trust.license.status==='declared'?trust.license.value:label('market.trust.licenseMissing','未注明许可证'),signature,compatibility:'Teloa '+trust.compatibility.teloa+' · DSH '+trust.compatibility.dsh,review:review+' · '+plainReviewSummary(trust.review.summary),skills,plugins:trust.plugins.map(value=>value.id+' @'+value.version+optional(value.required)),connections:trust.externalCapabilities.map(value=>(value.kind==='mcp'?'MCP':label('market.trust.connection','连接'))+' · '+value.id+optional(value.required)),permissions:trust.permissions.map(value=>value.id+' · '+value.description+optional(value.required)),installable:trust.signature.status!=='invalid'&&trust.review.conclusion!=='rejected'}
}
export function localizedMarketItemMetadata(item:Pick<MarketItem,'title'|'summary'|'localized'>,locale:string):{title:LocalizedMetadataResolution;summary:LocalizedMetadataResolution}{return {title:resolveMarketLocalizedMetadata(item.localized?.title??{original:item.title,defaultLocale:'und',locales:{}},locale),summary:resolveMarketLocalizedMetadata(item.localized?.summary??{original:item.summary,defaultLocale:'und',locales:{}},locale)}}
export function itemFromManifest(parsed:ParsedManifest,source:MarketSource):MarketItem{
  const manifest=parsed.manifest
  const localized=manifest.localized?{...(manifest.localized.title?{title:manifest.localized.title}:{}),...(manifest.localized.description?{summary:manifest.localized.description}:{}),...('requirements' in manifest.localized&&manifest.localized.requirements?{requirements:manifest.localized.requirements}:{}),...('output' in manifest.localized&&manifest.localized.output?{output:manifest.localized.output}:{})}:undefined
  if(isIndustryManifest(manifest))return {id:'content-'+parsed.hash,kind:'bundle',title:manifest.title,version:manifest.version,scope:manifest.scope,visibility:'personal',summary:manifest.description,...(localized?{localized}:{}),requirements:['核对资源内容、目标空间与待配置连接'],output:'建立行业工作空间及资源关联',author:'本人导入',license:'清单未注明许可，加载前需核对原许可',source,owner:'Teloa',compatibility:'行业资源及关联已解析；资源内容待读取，未加载到工作空间。',components:manifest.resources.map(resource=>({name:resource.title+' · '+resource.kind,required:resource.required,status:resource.source.kind==='local'?'包内内容待读取：'+resource.source.path:'公共资源待核对：'+resource.source.id+' @'+resource.source.version})),manifest,hash:parsed.hash,raw:parsed.raw}
  return {id:'content-'+parsed.hash,kind:manifest.format==='teloa.work-template/v1'?'template':'bundle',title:manifest.title,version:manifest.version,scope:manifest.domain,visibility:'personal',summary:manifest.description,...(localized?{localized}:{}),requirements:manifest.requirements,output:manifest.output,author:'本人导入',license:'清单未注明许可，安装前需核对原许可',source,owner:'Teloa',compatibility:manifest.format==='teloa.work-template/v1'?'已解析任务模板；使用前核对输入与所需的技能，不涉及扩展安装。':'已解析清单；依赖内容与 Teloa 兼容性待核验，未安装。',components:manifest.format==='teloa.business-package/v1'?manifest.components.map(item=>({name:item.kind+' · '+item.path,required:item.required,status:'组件待读取，兼容性待验证'})):manifest.skills.map(item=>({name:item.title+' @'+item.version,required:true,status:'引用待核对，未自动加载'})),manifest,hash:parsed.hash,raw:parsed.raw}
}
export function importManifest(state:MarketState,parsed:ParsedManifest,source:MarketSource,_now:string):MarketState{
  if(state.items.some(item=>item.hash===parsed.hash&&!item.packageContent))return state
  return {...state,items:[...state.items,itemFromManifest(parsed,source)]}
}
export function sourceItem(id:string,title:string,source:MarketSource,scope:string):MarketItem{return {id,kind:'bundle',title:text(title,'名称',120),version:'待锁定',scope,visibility:'personal',summary:source.kind==='conversation'?source.request:'保留来源，等待取得并核对实际内容。',requirements:['取得实际内容','锁定的提交或内容校验值','检查许可、必需组件和 Teloa 兼容性'],output:'可核对的安装预览',author:'本人保存',license:'待核对',source,owner:'Teloa',compatibility:'仅保存来源，未下载、解包或安装。',components:[]}}
/**
 * 正式市场的初始状态。目录内容只允许由 MarketContentStore 等持久服务写入，
 * 不能在客户端启动时混入演示条目。
 */
export const emptyMarket=():MarketState=>({items:[],intents:[]})

/**
 * 独立沙盒与组件测试使用的目录。调用方必须显式选择沙盒，正式工作台不得使用。
 */
export const sandboxMarket=():MarketState=>({items:marketExamples(),intents:[]})

/**
 * 推荐行业方案：Teloa 内置的三份行业方案。正式目录里一条方案都没有时（内置示例包只经
 * `pnpm setup:workspace` 写进后端内容库），市场首页先展示它们，用户从这里「添加到我的团队」，
 * 添加仍走既有的两段式知情同意。与沙盒目录读同一份内置定义，不另写一份方案清单。
 */
export const builtinSolutionCatalog=():MarketItem[]=>marketExamples().filter(item=>item.kind==='bundle')
export function filterMarket(items:MarketItem[],filter:{kind:MarketKind|'all';scope:string;visibility:string;query:string;searchValues?:(item:MarketItem)=>readonly string[]}){
  const query=filter.query.trim().toLocaleLowerCase()
  return items.filter(item=>(filter.kind==='all'||item.kind===filter.kind)
    &&(filter.scope==='all'||(filter.scope==='security'?['SOC','AppSec','CloudSec','DataSec','GRC'].includes(item.scope):item.scope===filter.scope))
    &&(filter.visibility==='all'||item.visibility===filter.visibility)
    &&[...(filter.searchValues?.(item)??[]),item.title,item.summary,item.protocol||'',item.id].some(value=>value.toLocaleLowerCase().includes(query)))
}
export function saveMarketIntent(state:MarketState,input:Omit<MarketIntent,'version'|'itemVersion'|'status'|'createdAt'|'updatedAt'> & {now:string;targets?:readonly MarketTarget[]}):MarketState{
  const item=state.items.find(item=>item.id===input.itemId)
  if(!item)throw Error('市场内容不存在。')
  const targetRef=input.targetRef?freezeMarketTarget(input.targetRef,input.targets||[]):undefined
  const id=text(input.id,'草案编号'),scope=targetRef?.scope||text(input.scope,'业务范围',80),target=targetRef?.title||text(input.target,'应用目标',300),purpose=text(input.purpose,'使用需求',4000)
  if(!['personal','team'].includes(input.visibility))throw Error('只能保存本人或团队草案。')
  const same=state.intents.find(draft=>draft.itemId===item.id&&draft.itemVersion===item.version&&draft.scope===scope&&(targetRef?(!!draft.targetRef&&marketTargetKey(draft.targetRef)===marketTargetKey(targetRef)&&draft.targetRef.version===targetRef.version):(!draft.targetRef&&draft.target===target))&&draft.status==='draft')
  if(same)return state
  if(state.intents.some(draft=>draft.id===id))throw Error('草案编号冲突。')
  return {...state,intents:[...state.intents,{id,version:1,itemId:item.id,itemVersion:item.version,scope,target,...(targetRef?{targetRef}:{}),purpose,visibility:input.visibility,status:'draft',createdAt:input.now,updatedAt:input.now}]}
}
export function updateMarketIntent(state:MarketState,input:{id:string;expectedVersion:number;purpose:string;visibility:'personal'|'team';action:'edit'|'withdraw';now:string}):MarketState{
  const draft=state.intents.find(item=>item.id===input.id)
  if(!draft||draft.version!==input.expectedVersion)throw Error('草案版本已变化，请重新打开。')
  if(draft.status==='withdrawn')throw Error('草案已撤回，历史内容保留。')
  if(!['personal','team'].includes(input.visibility))throw Error('只能保存本人或团队草案。')
  const purpose=text(input.purpose,'使用需求',4000)
  return {...state,intents:state.intents.map(item=>item.id===draft.id?{...item,purpose,visibility:input.visibility,preparation:undefined,version:item.version+1,status:input.action==='withdraw'?'withdrawn':'draft',updatedAt:input.now}:item)}
}
export async function createTeamTemplate(value:{id:string;title:string;domain:string;description:string;requirements:string[];output:string;visibility:string}):Promise<MarketItem>{
  if(!['personal','team'].includes(value.visibility))throw Error('只能保存为本人或团队草案，不直接公开发布。')
  const parsed=await parseMarketManifest(JSON.stringify({format:'teloa.work-template/v1',id:value.id,title:value.title,version:'1.0.0',domain:value.domain,description:value.description,requirements:value.requirements,output:value.output,skills:[]},null,2))
  return {...itemFromManifest(parsed,{kind:'created'}),visibility:value.visibility as 'personal'|'team',author:'本人创建',license:'本人定义，待补充发布许可'}
}
export function marketPrompt(item:MarketItem,draft?:MarketIntent):string{
  return (item.kind==='template'?'请按以下任务模板起草工作成果：':'请先起草以下资源的配置方案：')+item.title+' '+item.version+'\n工作目标：'+(draft?.purpose||item.summary)+'\n输入要求：'+item.requirements.join('；')+'\n交付要求：'+item.output+'\n来源：'+sourceLabel(item.source)+(item.hash?'\n内容 SHA-256：'+item.hash:'')+(draft?'\n本地能力使用方案：'+draft.id+' v'+draft.version+'；目标：'+draft.target+'；业务：'+draft.scope+(draft.targetRef?'；目标身份：'+draft.targetRef.kind+' / '+draft.targetRef.id+' v'+draft.targetRef.version:''):'')+(item.manifest?'\n已审阅的定义：\n'+JSON.stringify(item.manifest,null,2):'')+'\n只起草可审阅内容，不安装、授权或改动生产系统。此能力使用方案尚未接入 Agent 写入服务，请勿声称已保存或应用配置。缺少资料和工具时明确指出，不自动扩大权限。'
}
const builtinDetailEnglish:Readonly<Record<string,string>>={
  'Teloa 示例':'Teloa example','内置演示定义；不是第三方已认证扩展':'Built-in demo definition; not a certified third-party extension',
  '明确工作目标与获准资料':'Define the work objective and approved materials','核对负责员工与完成要求':'Confirm the responsible employee and completion requirements','可审阅草案与来源说明':'A reviewable draft with source notes',
  '示例定义；实际内容、依赖与 Teloa 兼容性尚待验证。':'Demo definition; actual content, dependencies, and Teloa compatibility have not been verified.',
  '公共报告撰写技能':'Shared report-writing Skill','复用意向，已保存内容待取得':'Reuse intended; saved content still required','研究与协作岗位':'Research and collaboration role','职责定义待绑定':'Role definition awaiting binding','团队知识连接':'Team knowledge connection','由组织提供实际来源':'The organization provides the actual source',
  'SOC 调查岗与 AppSec 审计岗':'SOC investigator and AppSec auditor roles','职责、身份与权限待配置':'Responsibilities, identities, and permissions await configuration','告警调查与代码审计方法':'Alert investigation and code audit methods','方法内容与工具依赖待核验':'Method content and tool dependencies require verification','优先复用相同版本':'Prefer reuse of the same version','告警数据与处置连接':'Alert data and response connection','查询和执行分别授权':'Authorize queries and execution separately',
  '当前固定 DSH 只桥接 tools，支持 stdio / Streamable HTTP；不桥接 resources、prompts 或 task-based 工具。该具体服务尚未连接。':'The pinned DSH version bridges tools over stdio or Streamable HTTP. It does not bridge resources, prompts, or task-based tools. This service is not connected.',
  '在隔离 DSH profile 核对兼容性':'Verify compatibility in an isolated DSH profile','安装前核对外部 CDN、脚本执行和资源占用边界':'Review external CDN access, script execution, and resource limits before installation','会话内可重放的交互可视化卡片':'Replayable interactive visualization cards in conversations',
  '已完成静态接口审查；尚未安装，仍需真实加载、历史重放、主题和卸载验证。':'Static interfaces have been reviewed. Installation, real loading, history replay, themes, and removal still require verification.','来源仓库组件，尚未安装':'Source repository component; not installed','Web 交互卡片扩展':'Web interactive card extension',
}
function marketExamples():MarketItem[]{
  const localized=(original:string,english:string):LocalizedMetadata=>({original,defaultLocale:'en',locales:{en:english,'zh-CN':original}})
  const detail=(value:string)=>localized(value,builtinDetailEnglish[value]??value)
  const make=(id:string,kind:MarketKind,title:string,scope:string,summary:string,english:{title:string;summary:string},extra:Partial<MarketItem>={}):MarketItem=>{
    const item:MarketItem={id,kind,title,scope,summary,version:'0.1.0',visibility:'public',author:'Teloa 示例',license:'内置演示定义；不是第三方已认证扩展',source:{kind:'builtin'},requirements:['明确工作目标与获准资料','核对负责员工与完成要求'],output:'可审阅草案与来源说明',owner:kind==='skill'?'DSH':'Teloa',compatibility:'示例定义；实际内容、依赖与 Teloa 兼容性尚待验证。',components:[],...extra}
    return {...item,localized:{title:localized(title,english.title),summary:localized(summary,english.summary),requirements:item.requirements.map(detail),output:detail(item.output),author:detail(item.author),license:detail(item.license),compatibility:detail(item.compatibility),components:item.components.map(component=>({name:detail(component.name),status:detail(component.status)}))}}
  }
  return [
    make('template-weekly','template','团队周报','general','归纳进展、阻塞和下一步，先形成可审阅周报。',{title:'Team weekly report',summary:'Summarize progress, blockers, and next steps in a reviewable weekly report.'}),
    make('template-research','template','资料研究与报告','general','核对资料来源，区分事实、推断与待验证问题。',{title:'Research and reporting',summary:'Verify sources and distinguish facts, inferences, and open questions.'}),
    make('template-meeting','template','会议纪要与行动项','general','提炼决定、责任人和后续工作，外发前由本人确认。',{title:'Meeting notes and action items',summary:'Capture decisions, owners, and follow-up work for review before sharing.'}),
    make('template-code','template','代码审计','AppSec','围绕指定代码版本核对风险与证据，审计结论与修复操作分别记录。',{title:'Code audit',summary:'Review risks and evidence against a fixed code version, keeping findings separate from remediation actions.'}),
    make('template-brief','template','设计 Brief 整理','Design','明确受众、素材、品牌约束与交付要求。',{title:'Design brief',summary:'Define the audience, assets, brand constraints, and delivery requirements.'},{visibility:'team'}),
    make('bundle-general','bundle','通用协作模板','general','组合研究、写作、会议协作与定期检查。',{title:'General collaboration template',summary:'Combine research, writing, meeting collaboration, and recurring reviews.'},{components:[{name:'公共报告撰写技能',required:true,status:'复用意向，已保存内容待取得'},{name:'研究与协作岗位',required:true,status:'职责定义待绑定'},{name:'团队知识连接',required:false,status:'由组织提供实际来源'}],manifest:builtinIndustryManifests['bundle-general']}),
    make('bundle-security','bundle','安全行业模板','SOC','以安全运营和应用安全为首批场景，组合员工、任务模板、数据和执行要求。',{title:'Security industry template',summary:'Combine employees, task templates, data, and execution requirements for security operations and application security.'},{components:[{name:'SOC 调查岗与 AppSec 审计岗',required:true,status:'职责、身份与权限待配置'},{name:'告警调查与代码审计方法',required:true,status:'方法内容与工具依赖待核验'},{name:'公共报告撰写技能',required:true,status:'优先复用相同版本'},{name:'告警数据与处置连接',required:true,status:'查询和执行分别授权'}],manifest:builtinIndustryManifests['bundle-security']}),
    make('bundle-design','bundle','设计行业模板','Design','组合 Brief、素材规范、版本审阅与交付流程。',{title:'Design industry template',summary:'Combine briefs, asset guidelines, version reviews, and delivery workflows.'},{manifest:builtinIndustryManifests['bundle-design']}),
    make('role-research','role','研究助理','general','在获准资料范围内整理来源和结论。',{title:'Research assistant',summary:'Organize sources and conclusions within the approved information scope.'}),
    make('role-investigator','role','调查岗','SOC','核对告警与证据，形成建议，高风险操作回流本人。',{title:'Investigator',summary:'Review alerts and evidence, recommend next steps, and return high-risk actions for human decision.'}),
    make('skill-report','skill','报告撰写','general','复用公共写作方法，保留来源与未确认事项。',{title:'Report writing',summary:'Use a shared writing method while preserving sources and unresolved points.'},{owner:'DSH',capabilityCategories:['写作','分析']}),
    make('skill-audit','skill','代码审计方法','AppSec','固定代码版本、记录可复现证据与修复建议。',{title:'Code audit method',summary:'Pin the code version and record reproducible evidence and remediation recommendations.'},{owner:'DSH',capabilityCategories:['代码分析','安全审计']}),
    make('resource-mcp','resource','MCP 工具连接','general','复用已有 MCP 服务，查询与执行能力按目标范围绑定。',{title:'MCP tool connection',summary:'Reuse an existing MCP service and bind query and execution capabilities to the target scope.'},{protocol:'MCP',owner:'DSH',compatibility:'当前固定 DSH 只桥接 tools，支持 stdio / Streamable HTTP；不桥接 resources、prompts 或 task-based 工具。该具体服务尚未连接。'}),
    make('resource-knowledge','resource','团队知识','general','将团队文档作为有来源和读取边界的知识。',{title:'Team knowledge',summary:'Use team documents as knowledge with clear sources and access boundaries.'},{visibility:'team',owner:'Teloa',resourceKind:'knowledge'}),
    make('resource-edr','resource','告警与处置连接','SOC','列出告警来源读取与目标系统处置能力，分别绑定和授权。',{title:'Alert and response connection',summary:'Lists alert-source access and target-system response capabilities with separate bindings and authorization.'},{owner:'Teloa',resourceKind:'data-source'}),
    // dsh-visualize（第三方 GitHub 插件，非 @deepseek-ai/*）已整体下线：与「产品底座只用官方插件」冲突，
    // 且其会话内可视化在 Teloa 里非必要（业务看板图表已原生实现）。
  ]
}
