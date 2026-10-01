import {isIndustryManifest} from './industry-manifest.ts'
import {readBusinessDefinitionBody,type BusinessDefinitionKind} from '@teloa/contract'
import type {BusinessShareDeclaration,BusinessShareInput} from './business-share-package.js'
import type {BusinessCustomizationApi} from './business-customization-api.js'
import type {IndustryLoadRecord} from './industry-load-api.js'
import {inspectIndustryContent} from './industry-content.ts'
import type {MarketContentApi} from './market-content-api.js'

/**
 * 分享只读取已经固定、已经加载的模板字节，以及本人当前生效的本地声明版本。
 * 不读取台账快照、对象取值或连接凭据；本地版本正文来自第二期目录中的已生效草案，
 * 因此不会另造存储或新增 RPC。
 */
export type BusinessShareSource={read:(scope:string)=>Promise<Pick<BusinessShareInput,'objectTypes'|'views'|'actions'|'sources'|'available'>>}

type SourcePorts={customization:BusinessCustomizationApi;market:MarketContentApi;loads:()=>readonly IndustryLoadRecord[]}
type DeclarationSets={objectTypes:BusinessShareDeclaration[];views:BusinessShareDeclaration[];actions:BusinessShareDeclaration[]}

const key=(kind:BusinessDefinitionKind,id:string)=>kind+'\0'+id
const declaration=(kind:BusinessDefinitionKind,body:unknown):BusinessShareDeclaration=>{
 const definition=readBusinessDefinitionBody(kind,body)
 return {localId:definition.id,version:definition.version,body:definition}
}
const add=(target:DeclarationSets,kind:BusinessDefinitionKind,row:BusinessShareDeclaration)=>{
 const field=kind==='object-type'?'objectTypes':kind==='view'?'views':'actions'
 const index=target[field].findIndex(item=>item.localId===row.localId)
 if(index<0)target[field].push(row)
 else target[field][index]=row
}

/** 将市场固定内容投影成「声明正文 + 可用连接件」，而不是从台账结果倒推声明。 */
export function createBusinessShareSource({customization,market,loads}:SourcePorts):BusinessShareSource{
 return {async read(scope){
  const active=loads().filter(load=>load.status==='active'&&load.scope===scope&&load.space.scope===scope)
  const [directory,items]=await Promise.all([customization.directory({scope}),market.list()])
  const byContentId=new Map(items.flatMap(item=>item.contentStorage?.contentId?[ [item.contentStorage.contentId,item] as const ]:[]))
  const declarations:DeclarationSets={objectTypes:[],views:[],actions:[]}
  const sources=new Map<string,{sourceId:string;sourceNoun?:string}>()
  for(const load of active){
   const summary=byContentId.get(load.contentId)
   if(!summary)throw Error('已加载模板的固定内容不在当前市场目录中。')
   const item=await market.hydrate(summary)
   if(!item.manifest||!isIndustryManifest(item.manifest)||!item.packageContent)throw Error('已加载模板缺少可分享的固定内容。')
   for(const inspection of inspectIndustryContent(item.manifest,item.packageContent)){
    if(inspection.state!=='parsed'||!inspection.definition)continue
    const definition=inspection.definition
    if(definition.kind==='object-type')add(declarations,'object-type',declaration('object-type',definition.definition))
    else if(definition.kind==='business-view')add(declarations,'view',declaration('view',definition.definition))
    else if(definition.kind==='business-action')add(declarations,'action',declaration('action',definition.definition))
    else if(definition.kind==='data-source')sources.set(definition.definition.sourceId,{sourceId:definition.definition.sourceId,...(definition.definition.sourceNoun?{sourceNoun:definition.definition.sourceNoun}:{})})
   }
  }
  // 本地当前版本覆盖同标识模板；回退到模板时 current 缺省，不会错误带出历史草案。
  const drafts=new Map(directory.drafts.filter(draft=>draft.status==='applied').map(draft=>[draft.id,draft]))
  for(const entry of directory.entries){
   if(!entry.current)continue
   const draft=drafts.get(entry.current.draftId)
   if(!draft||draft.kind!==entry.kind||draft.localId!==entry.localId)throw Error('当前本地声明版本缺少对应的已生效草案。')
   let body:unknown
   try{body=JSON.parse(draft.body)}catch{throw Error('当前本地声明正文不是有效 JSON。')}
   add(declarations,entry.kind,declaration(entry.kind,body))
  }
  const available={
   /**
    * 本包刻意不带任务模板正文；即使原空间已有模板，它也不是接收方加载时的同一加载项。
    * 因而动作在生成阶段一律按「任务模板不可随包闭合」排除，避免做出接收方必然读不出的声明包。
    */
   workTemplates:[],
   executionTools:active.flatMap(load=>load.items.filter(item=>item.kind==='execution-tool'&&['pending-adapter','instantiated','active','detached'].includes(item.status)).map(item=>item.localId)),
  }
  return {
   objectTypes:declarations.objectTypes.sort((a,b)=>a.localId.localeCompare(b.localId)),
   views:declarations.views.sort((a,b)=>a.localId.localeCompare(b.localId)),
   actions:declarations.actions.sort((a,b)=>a.localId.localeCompare(b.localId)),
   sources:[...sources.values()].sort((a,b)=>a.sourceId.localeCompare(b.sourceId)),
   available:{workTemplates:[...new Set(available.workTemplates)].sort(),executionTools:[...new Set(available.executionTools)].sort()},
  }
 }}
}
