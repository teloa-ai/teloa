import type { BusinessObject } from './business-preview.js'
import type { CollaborationScope } from './collaboration-preview.js'

export type BusinessSourceSummary={
  source:string
  total:number
  missing:number
  latestReceivedAt:string
  types:string[]
}

export function summarizeBusinessSources(objects:readonly BusinessObject[],scope:CollaborationScope,locale:string):BusinessSourceSummary[]{
  const rows=new Map<string,BusinessSourceSummary>()
  for(const object of objects){
    if(object.scope!==scope)continue
    const existing=rows.get(object.source)
    if(existing){
      existing.total+=1
      if(object.quality==='missing')existing.missing+=1
      if(Date.parse(object.receivedAt)>Date.parse(existing.latestReceivedAt))existing.latestReceivedAt=object.receivedAt
      if(!existing.types.includes(object.type))existing.types.push(object.type)
      continue
    }
    rows.set(object.source,{source:object.source,total:1,missing:object.quality==='missing'?1:0,latestReceivedAt:object.receivedAt,types:[object.type]})
  }
  return [...rows.values()].sort((left,right)=>left.source.localeCompare(right.source,locale))
}
