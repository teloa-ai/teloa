import {isRecord,industryModelPhases,type IndustryModelProbe,type MarketCatalogModelEntry} from '@teloa/contract'
import type {Context} from '@deepseek-ai/cordis'

/**
 * 语音与本地检索都是可停用扩展，不能设为 harness 必需依赖；Cordis 的公开反射读口只返回当前活跃服务。
 * 本地检索的服务由随附扩展 `@teloa/local-embedding` 提供为 `teloaEmbedding`（规格 §5.2、§7.2），这里只按名字发现，不引入扩展源码。
 */
export function createHostIndustryModelProbe(ctx:Context,entry:(id:string)=>MarketCatalogModelEntry|undefined):IndustryModelProbe{
 const read=(name:string)=>()=>{
  const service=ctx.reflect.get(name) as {snapshot:()=>unknown}|undefined
  return service?.snapshot()
 }
 return createIndustryModelProbe(entry,read('speechToText'),read('teloaEmbedding'))
}

/**
 * DSH 0.1.7-rc.1 的公开 speechToText.snapshot() 与同形的 teloaEmbedding.snapshot()；只读，不启用插件、不下载、不切换默认 provider。
 * 目录条目的 `usage` 与 `native.kind` 决定读哪一份快照：错配一律 `unsupported`，不读任何快照。
 */
export function createIndustryModelProbe(entry:(id:string)=>MarketCatalogModelEntry|undefined,speechSnapshot:()=>unknown,embeddingSnapshot:()=>unknown=()=>undefined):IndustryModelProbe{
 return async dependency=>{
  const model=entry(dependency.catalogId)
  if(!model||model.version!==dependency.version||model.compatibility.status==='unsupported'||model.model.form!=='local-specialist'||!(model.model.usage as readonly string[]).includes(dependency.usage))return 'unsupported'
  const native=model.model.native
  const read=dependency.usage==='speech-to-text'&&native.kind==='dsh-speech'?speechSnapshot:dependency.usage==='embedding'&&native.kind==='teloa-embedding'?embeddingSnapshot:undefined
  if(!read)return 'unsupported'
  let snapshot:unknown
  try{snapshot=read()}catch{return 'unavailable'}
  if(snapshot===undefined)return 'disabled'
  if(!isRecord(snapshot)||!Array.isArray(snapshot.providers))return 'unavailable'
  const provider=snapshot.providers.find(row=>isRecord(row)&&row.id===native.providerId)
  if(!provider)return 'disabled'
  if(!isRecord(provider)||provider.location!=='host-local'||!isRecord(provider.preparation))return 'unavailable'
  const phase=provider.preparation.phase
  return industryModelPhases.find(value=>value===phase)??'unavailable'
 }
}
