import type {AtomicSkillDerivationBinding} from './market-content-api.js'
import type {SkillDerivativeDraft} from './skill-derivation.js'

type Saved={contentId:string;hash:string;logicalId:string;version:string}
type Stored={schema:'teloa.skill-derivative-draft/v1';binding:AtomicSkillDerivationBinding}&({state:'draft';title:string;version:string;categories:string[];edits:{path:string;text:string}[]}|{state:'saved';saved:Saved})
let database:Promise<IDBDatabase>|undefined
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const key=(binding:AtomicSkillDerivationBinding)=>stable(binding)
const connect=()=>database??=(new Promise<IDBDatabase>((resolve,reject)=>{
 const request=indexedDB.open('teloa.skill-derivative-drafts',1)
 request.onupgradeneeded=()=>request.result.createObjectStore('drafts')
 request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=undefined};resolve(db)}
 request.onerror=()=>{database=undefined;reject(request.error)}
}))
export async function readSkillDerivativeDraft(binding:AtomicSkillDerivationBinding):Promise<Stored|undefined>{
 const db=await connect(),value=await new Promise<Stored|undefined>((resolve,reject)=>{const request=db.transaction('drafts','readonly').objectStore('drafts').get(key(binding));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
 if(value&&(value.schema!=='teloa.skill-derivative-draft/v1'||!['draft','saved'].includes(value.state)||stable(value.binding)!==stable(binding)))throw Error('技能草稿来源不一致，已停止恢复。')
 return value
}
async function write(binding:AtomicSkillDerivationBinding,value:Stored){
 const db=await connect();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(value,key(binding));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??Error('技能草稿未完成保存。'))})
}
/** 本机草稿只保存本人已授权固定来源的文本修改；二进制与原许可仍从原固定内容核对读取。 */
export function saveSkillDerivativeDraft(binding:AtomicSkillDerivationBinding,value:SkillDerivativeDraft){return write(binding,{schema:'teloa.skill-derivative-draft/v1',binding,state:'draft',title:value.title,version:value.version,categories:[...value.categories],edits:value.files.filter(file=>!file.locked&&file.text!==undefined).map(file=>({path:file.path,text:file.text!}))})}
export function saveSkillDerivativeReceipt(binding:AtomicSkillDerivationBinding,saved:Saved){return write(binding,{schema:'teloa.skill-derivative-draft/v1',binding,state:'saved',saved})}
export function restoreSkillDerivativeDraft(original:SkillDerivativeDraft,stored:Extract<Stored,{state:'draft'}>):SkillDerivativeDraft{
 if(typeof stored.title!=='string'||stored.title.length>120||typeof stored.version!=='string'||stored.version.length>80||!Array.isArray(stored.categories)||stored.categories.length>20||stored.categories.some(value=>typeof value!=='string'||value.length>80)||!Array.isArray(stored.edits))throw Error('技能草稿内容不完整。')
 const editable=original.files.filter(file=>!file.locked&&file.text!==undefined),edits=new Map(stored.edits.map(file=>[file.path,file.text]))
 if(edits.size!==editable.length||stored.edits.length!==edits.size||editable.some(file=>typeof edits.get(file.path)!=='string')||stored.edits.some(file=>new TextEncoder().encode(file.text).length>2*1024*1024))throw Error('技能草稿配套文件不一致。')
 return {...original,title:stored.title,version:stored.version,categories:[...stored.categories],files:original.files.map(file=>!file.locked&&file.text!==undefined?{...file,text:edits.get(file.path)!}:file)}
}
