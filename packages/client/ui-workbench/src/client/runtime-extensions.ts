import type {BundleInfo,PluginInfo} from '@deepseek-ai/dsh-api-remotes/client'

/** 与当前官方管理页相同的系统组合包，另加 Teloa 的两项必需组合。其他锁定包仍可查阅。 */
const SYSTEM_BUNDLES=new Set(['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@deepseek-ai/dsh-headless','@deepseek-ai/dsh-sdk-app','@deepseek-ai/dsh-acp-app','@deepseek-ai/dsh-sdk-minimal','@teloa/bundle','@deepseek-ai/dsh-experimental-agent-team-profile'])
export type RuntimeExtension=Omit<BundleInfo,'rows'>&{
 rows:(BundleInfo['rows'][number]&{enabled?:boolean;fiberPhase?:PluginInfo['fiberPhase']})[]
 runtime:'active'|'failed'|'loading'|'inactive'|'unverified'
}
export function runtimeExtensions(bundles:readonly BundleInfo[],plugins:readonly PluginInfo[]):RuntimeExtension[]{
 const byId=new Map(plugins.map(row=>[String(row.entryId),row]))
 return bundles.filter(bundle=>!SYSTEM_BUNDLES.has(bundle.name)).map(bundle=>{
  const rows=bundle.rows.map(row=>{const live=row.entryId?byId.get(String(row.entryId)):undefined;return {...row,...(live?{enabled:live.enabled,fiberPhase:live.fiberPhase}:{})}})
  const runtime:RuntimeExtension['runtime']=bundle.error||rows.some(row=>row.fiberPhase==='failed')?'failed'
   :rows.some(row=>row.fiberPhase==='loading'||row.fiberPhase==='unloading')?'loading'
   :rows.some(row=>row.fiberPhase==='active')&&rows.every(row=>row.enabled===false||row.fiberPhase==='active')?'active'
   :(!bundle.enabled||rows.length>0&&rows.every(row=>row.enabled===false))&&!rows.some(row=>row.fiberPhase==='active')?'inactive':'unverified'
  return {...bundle,rows,runtime}
 }).sort((a,b)=>a.name.localeCompare(b.name))
}
export type RuntimeExtensionSnapshot={status:'idle'|'loading'|'ready'|'failed';items:RuntimeExtension[]}
/** 只读查询投影；操作和安装恢复仍由官方管理器及既有受管路径负责。 */
export function createRuntimeExtensionReader(read:()=>Promise<{bundles:BundleInfo[];plugins:PluginInfo[]}>){
 let state:RuntimeExtensionSnapshot={status:'idle',items:[]},generation=0,disposed=false
 const listeners=new Set<()=>void>()
 const publish=(next:RuntimeExtensionSnapshot)=>{state=next;for(const notify of listeners)notify()}
 return {
  getSnapshot:()=>state,
  subscribe:(notify:()=>void)=>{listeners.add(notify);return ()=>{listeners.delete(notify)}},
  async refresh(){
   if(disposed)return
   const current=++generation;publish({...state,status:'loading'})
   try{const result=await read();if(!disposed&&current===generation)publish({status:'ready',items:runtimeExtensions(result.bundles,result.plugins)})}
   catch{if(!disposed&&current===generation)publish({...state,status:'failed'})}
  },
  dispose(){disposed=true;generation++;listeners.clear()},
 }
}
export type RuntimeExtensionReader=ReturnType<typeof createRuntimeExtensionReader>
