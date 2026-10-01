type Storage={getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void}
/** 准入前的确定性拒收：请求未入队、未写会话日志，不属于「结果未知」。gateway/bad-request 覆盖空内容与贴密钥拒收（规格 §6）。 */
const deterministicPromptRejections=new Set(['gateway/bad-request','session/model-unavailable','session/attachment-invalid','session/invalid-time-zone','session/agent-busy','session/writer-held'])
export const isDeterministicPromptRejection=(code:unknown):boolean=>typeof code==='string'&&deterministicPromptRejections.has(code)
/** 仅记录官方已经分配的请求身份；不重发 prompt、不拥有正文和附件。 */
export class HomeSubmissionJournal{
 private readonly storage:Storage
 private readonly key:string
 private pending=new Set<string>()
 private live=new Set<string>()
 private restored=new Set<string>()
 private unknown=false
 private listeners=new Set<()=>void>()
 constructor(storage:Storage,sessionId:string){
  this.storage=storage;this.key='teloa.home-submission/'+sessionId
  try{const value:unknown=JSON.parse(storage.getItem(this.key)??'[]');if(Array.isArray(value))this.pending=new Set(value.filter((id):id is string=>typeof id==='string'))}catch{/* 不从损坏记录构造请求。 */}
  this.restored=new Set(this.pending);this.unknown=this.pending.size>0
 }
 getSnapshot=()=>this.unknown
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 observe(active:readonly string[],receipts:readonly string[],failed:boolean,rejected=false){
  // 每次观察重读同源日志，让已打开的其他标签页也认同待核对身份。
  try{const saved:unknown=JSON.parse(this.storage.getItem(this.key)??'[]');if(Array.isArray(saved)){this.pending=new Set(saved.filter((id):id is string=>typeof id==='string'));for(const id of this.pending)if(!this.live.has(id)&&!active.includes(id))this.restored.add(id)}}catch{/* 存储故障时保留本标签页已知身份。 */}
  for(const id of active)this.pending.add(id)
  for(const id of receipts){this.pending.delete(id);this.restored.delete(id)}
  if(rejected)for(const id of this.live)if(!active.includes(id)){this.pending.delete(id);this.restored.delete(id)}
  const unknown=[...this.pending].some(id=>this.restored.has(id)||failed||!active.includes(id))
  this.live=new Set(active)
  try{if(this.pending.size)this.storage.setItem(this.key,JSON.stringify([...this.pending]));else this.storage.removeItem(this.key)}catch{/* 无持久存储时仍保留运行期请求，不影响官方事件订阅。 */}
  if(this.unknown!==unknown){this.unknown=unknown;for(const listener of this.listeners)listener()}
 }
}
export type HomeSubmissionMonitor={getSnapshot:()=>boolean;subscribe:(listener:()=>void)=>()=>void;attach:()=>()=>void;check:()=>Promise<void>}
