import type {ProjectDetail,WorkProject} from '@teloa/contract'

type Reader={get:(id:string)=>Promise<ProjectDetail>}
type Summary=ProjectDetail['summary']
/** 只读取进入视口的卡片；同一连接合并请求，最多四个并发，短缓存不跨身份。 */
export function createProjectCardSummaryReader(api:Reader){
 const cache=new Map<string,{at:number;value:Promise<Summary>}>(),queue:Array<()=>void>=[]
 let active=0
 const next=()=>{while(active<4&&queue.length){active++;queue.shift()!()}}
 const read=(project:WorkProject):Promise<Summary>=>{
  const key=JSON.stringify([project.ownerId,project.id,project.scope,project.version,project.updatedAt]),now=Date.now(),cached=cache.get(key)
  if(cached&&now-cached.at<30000)return cached.value
  for(const [id,row] of cache)if(now-row.at>=30000)cache.delete(id)
  const value=new Promise<Summary>((resolve,reject)=>{queue.push(()=>{
   void api.get(project.id).then(detail=>{
    const actual=detail.project
    if(actual.id!==project.id||actual.ownerId!==project.ownerId||actual.scope!==project.scope||actual.version!==project.version||actual.updatedAt!==project.updatedAt)throw Error('项目已更新，请刷新目录。')
    resolve(detail.summary)
   }).catch(error=>{cache.delete(key);reject(error)}).finally(()=>{active--;next()})
  })})
  cache.set(key,{at:now,value});next();return value
 }
 return Object.assign(read,{invalidate:()=>cache.clear()})
}
const readers=new WeakMap<Reader,ReturnType<typeof createProjectCardSummaryReader>>()
export function projectCardSummary(api:Reader,project:WorkProject){
 let reader=readers.get(api);if(!reader){reader=createProjectCardSummaryReader(api);readers.set(api,reader)}return reader(project)
}
/** 用户刷新目录时即重读任务摘要，不等待短缓存自然过期。 */
export function invalidateProjectCardSummary(api:Reader){readers.get(api)?.invalidate()}
