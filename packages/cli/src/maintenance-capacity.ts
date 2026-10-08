export type MaintenanceBytes=number|bigint
export interface MaintenanceVolume{id:string;availableBytes:MaintenanceBytes;sharedSpaceId?:string}
export interface MaintenanceDemand{volumeId:string;bytes:MaintenanceBytes}
export interface MaintenanceCapacityRequirement{volumeIds:string[];demandBytes:bigint;reserveBytes:bigint;requiredBytes:bigint;availableBytes:bigint;shortfallBytes:bigint}
const bytes=(value:MaintenanceBytes):bigint=>{
 if(typeof value==='bigint'&&value>=0n)return value
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return BigInt(value)
 throw Error('维护容量统计必须是非负整数；大数须使用 BigInt。')
}
const identifier=(value:string)=>{if(typeof value!=='string'||!value.trim())throw Error('维护容量卷标识缺失。');return value}

/** 只计算同时峰值；不读取文件、证明归属或保证后续写入成功。未知共享关系保守合并。 */
export function planMaintenanceCapacity({volumes,demands,reserveBytes=256n*1024n*1024n}:{volumes:MaintenanceVolume[];demands:MaintenanceDemand[];reserveBytes?:MaintenanceBytes}){
 if(!Array.isArray(volumes)||!volumes.length||!Array.isArray(demands))throw Error('维护容量统计缺失。')
 const minimum=bytes(reserveBytes),known=new Map<string,{id:string;available:bigint;space?:string}>()
 for(const row of volumes){
  const id=identifier(row?.id)
  if(known.has(id))throw Error('维护容量卷标识重复。')
  known.set(id,{id,available:bytes(row.availableBytes),...(row.sharedSpaceId===undefined?{}:{space:identifier(row.sharedSpaceId)})})
 }
 const uncertain=[...known.values()].some(row=>row.space===undefined),groups=new Map<string,{ids:string[];available:bigint;demand:bigint}>(),volumeGroups=new Map<string,string>()
 for(const row of known.values()){
  const key=uncertain?'unknown':row.space!,previous=groups.get(key)
  volumeGroups.set(row.id,key)
  if(previous){previous.ids.push(row.id);if(row.available<previous.available)previous.available=row.available}
  else groups.set(key,{ids:[row.id],available:row.available,demand:0n})
 }
 for(const row of demands){
  const key=volumeGroups.get(identifier(row?.volumeId))
  if(key===undefined)throw Error('维护容量需求没有对应卷统计。')
  groups.get(key)!.demand+=bytes(row.bytes)
 }
 const requirements:MaintenanceCapacityRequirement[]=[...groups.values()].filter(row=>row.demand>0n).map(row=>{
  const percentage=(row.demand+4n)/5n,reserve=percentage>minimum?percentage:minimum,required=row.demand+reserve
  return {volumeIds:row.ids.sort(),demandBytes:row.demand,reserveBytes:reserve,requiredBytes:required,availableBytes:row.available,shortfallBytes:required>row.available?required-row.available:0n}
 })
 const shortfalls=requirements.filter(row=>row.shortfallBytes>0n)
 return {ok:shortfalls.length===0,requirements,shortfalls}
}
