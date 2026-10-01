import type {RuntimeExtension} from './runtime-extensions.js'
import type {IndustryPluginInstance} from './industry-plugin-api.js'
import type {CapabilitySnapshot} from '@teloa/contract'
import type {IndustryLoadRecord} from './industry-load-api.js'
import type {MessageKey} from './i18n/messages.js'
import type {TeamCapabilityRow} from './team-capabilities-presentation.js'
import {
 CAPABILITY_ROW_IDS,
 compositionTargetScope,
 composeFromWorkspace,
 type CompositionItemState,
 type CompositionRowId,
 type CompositionTarget,
 type ConnectorMode,
} from './industry-composition.js'

/**
 * 能力页跨业务四行（技能 / 接入源 / 任务模板 / 扩展）的唯一取数入口，供 `TeamCapabilitiesPage` 消费。
 * 不带业务范围的落点（技能、接入源、扩展）是一份共享的东西、只有一处可配，跨业务合并成一条，
 * 副标列出用到它的全部业务；带范围的落点（任务模板行）是各业务自己的做法，逐业务各一条。
 * 合并判据固定为 `templateId+'/'+localId`：`instanceId` 每次加载都会重新生成，跨业务必然不同，
 * 只有模板包内的 `localId` 与跨版本稳定的 `templateId` 认得出「同一条」。
 */
export type CapabilityOrigin={kind:'studio'}|{kind:'business';scopes:readonly string[]}
export type CapabilityItem={native?:RuntimeExtension;key:string;rowId:CompositionRowId;title:string;state:CompositionItemState;mode?:ConnectorMode;approval?:boolean;detail?:MessageKey;origin:CapabilityOrigin;go:CompositionTarget;instanceId?:string;industry?:TeamCapabilityRow['industry']}
export type CapabilitySection={id:CompositionRowId;items:CapabilityItem[]}

/**
 * 合并后状态取最差一档：数字越大越差。免得一条连接在 A 业务断了、B 业务好着，
 * 面板却因为 B 业务好着就说它「已连接」，把还差的一步藏起来。同一行的状态本就同一族
 * （技能三档 / 接入源两档 / 扩展三档），不会跨族比较。
 */
const STATE_SEVERITY:Readonly<Partial<Record<CompositionItemState,number>>>={
 'install-failed':7,unverified:6,installing:5,'pending-enable':4,'pending-install':4,'pending-authorization':3,disconnected:2,'needs-restart':1,installed:0,connected:0,
}
const worseState=(a:CompositionItemState,b:CompositionItemState):CompositionItemState=>
 (STATE_SEVERITY[a]??0)>=(STATE_SEVERITY[b]??0)?a:b

type LoadItem=IndustryLoadRecord['items'][number]
const findLoadItem=(loads:readonly IndustryLoadRecord[],instanceId:string):{load:IndustryLoadRecord;item:LoadItem}|undefined=>{
 for(const load of loads){
  const item=load.items.find(entry=>entry.instanceId===instanceId)
  if(item)return {load,item}
 }
 return undefined
}
const industryInfo=(load:IndustryLoadRecord,item:LoadItem):NonNullable<CapabilityItem['industry']>=>
 ({spaceName:load.space.name,required:item.required,templateTitle:load.templateTitle,templateVersion:load.templateVersion,resourceVersion:item.version,templateId:load.templateId,contentHash:load.contentHash})

/**
 * 每个已加载的业务范围各调一次既有 `composeFromWorkspace`，只取跨业务复用的四行；
 * 原生（非业务带来的）条目按 Ruling 2 收敛到共享状态词：DSH 技能记 `installed`、
 * observed 工具记 `discovered`，`not-connected` 不产条目、由页面走空态句。
 */
export function capabilitySections(input:{snapshot?:CapabilitySnapshot;loads:readonly IndustryLoadRecord[];plugins?:readonly IndustryPluginInstance[]}):CapabilitySection[]{
 const byRow=new Map<CompositionRowId,CapabilityItem[]>(CAPABILITY_ROW_IDS.map(id=>[id,[]]))
 const shared=new Map<string,CapabilityItem>()
 const scopes=[...new Set(input.loads.map(load=>load.space.scope))]

 for(const scope of scopes){
  const sections=composeFromWorkspace({scope,loads:input.loads,roles:[],...(input.plugins?{plugins:input.plugins}:{})})
  for(const section of sections){
   if(!CAPABILITY_ROW_IDS.includes(section.id))continue
   for(const compItem of section.items){
    const located=findLoadItem(input.loads,compItem.id)
    // 业务的做法汇总含自动化和对象动作；能力目录只收可复用的任务模板。
    if(section.id==='method'&&located?.item.kind!=='work-template')continue
    const base={
     rowId:section.id,title:compItem.title,state:compItem.state,
     ...(compItem.mode?{mode:compItem.mode}:{}),...(compItem.approval?{approval:true}:{}),
     go:compItem.go,instanceId:compItem.id,
     ...(located?{industry:industryInfo(located.load,located.item)}:{}),
    }
    if(compositionTargetScope(compItem.go)===undefined){
     const mergeKey=section.id+':'+(located?located.load.templateId+'/'+located.item.localId:compItem.id)
     const existing=shared.get(mergeKey)
     if(existing&&existing.origin.kind==='business'){
      const state=worseState(existing.state,compItem.state)
      // 状态与配置入口必须指向同一个实例，才能处理其他业务里尚未就绪的能力。
      shared.set(mergeKey,{...existing,...(state!==existing.state?{instanceId:base.instanceId,industry:base.industry,go:base.go}:{}),state,origin:{kind:'business',scopes:[...new Set([...existing.origin.scopes,scope])]}})
     }else{
      shared.set(mergeKey,{...base,key:mergeKey,origin:{kind:'business',scopes:[scope]}})
     }
    }else{
     byRow.get(section.id)!.push({...base,key:scope+':'+compItem.id,origin:{kind:'business',scopes:[scope]}})
    }
   }
  }
 }
 for(const item of shared.values())byRow.get(item.rowId)!.push(item)

 for(const skill of input.snapshot?.skills??[])
  byRow.get('skill')!.push({key:'skill:'+skill.name,rowId:'skill',title:skill.name,state:'installed',detail:skill.userInvocable?'teamCapability.status.userInvocable':'teamCapability.status.agentOnly',origin:{kind:'studio'},go:{kind:'capabilities'}})
 if(input.snapshot?.connections.status==='observed')
  for(const tool of input.snapshot.connections.tools)
   byRow.get('source')!.push({key:'source:'+tool.name,rowId:'source',title:tool.name,state:'discovered',detail:'teamCapability.status.verifyOnCall',origin:{kind:'studio'},go:{kind:'connectors'}})

 return CAPABILITY_ROW_IDS.map(id=>({id,items:byRow.get(id)!}))
}
