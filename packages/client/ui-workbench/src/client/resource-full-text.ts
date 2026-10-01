import {promptFullTextMaxBytes,type SourceReference,type WorkResource} from '@teloa/contract'

/**
 * 按来源目录登记的字节数找出整段进提示词会超限的资料（资源 ID → KiB，向上取整）。
 * 只按同一来源版本匹配；目录里找不到的资料不判定，保存时宿主仍会复核。
 */
export function oversizedResources(resources:readonly WorkResource[],sources:readonly SourceReference[]):Map<string,number>{
  const bytes=new Map(sources.map(source=>[source.id+'@'+source.version,source.bytes]))
  const result=new Map<string,number>()
  for(const resource of resources){
    const size=bytes.get(resource.sourceId+'@'+resource.sourceVersion)
    if(size!==undefined&&size>promptFullTextMaxBytes)result.set(resource.id,Math.ceil(size/1024))
  }
  return result
}
