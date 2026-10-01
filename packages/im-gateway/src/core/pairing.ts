/**
 * 配对码闭环（规格 §5.1）：纯内存，宿主重启即清。
 * 6 位数字、10 分钟、一次性；同一渠道同时只有一个有效码；有效码在群内出现即作废（错码不影响码、不计错）；
 * 同一 (channelId,imUserId) 连续错 5 次锁 15 分钟，锁内一律 locked（含正确码），不透露是否存在有效码；
 * 同一有效码跨所有账号累计错 20 次即作废（防换号穷举），审计记一条 pair-rejected/code-exhausted（不含码值）。
 * 码值只经 create 的返回值交给设置页，peek 与任何其它出口都不带码。
 */
import {randomInt,timingSafeEqual} from 'node:crypto'
import type {ImChatKind} from './types.ts'
import type {ImAuditRow} from './audit.ts'

export type PairingDeps={now:()=>number;random:()=>string;audit?:{record(row:ImAuditRow):Promise<void>}}
export type RedeemResult={kind:'bound'}|{kind:'invalid'}|{kind:'locked';until:number}|{kind:'already-bound'}|{kind:'not-in-direct'}

const codeTtlMs=10*60_000
const maxFailures=5
const lockMs=15*60_000
/** 同一有效码跨账号累计错码上限，达到即作废。 */
const maxCodeFailures=20
/** 错码计数表上限：未绑定者可换账号反复试，超过即淘汰最早的记录，防止内存无界增长。 */
const failureLimit=10_000
const codePattern=/^\d{6}$/

/** 6 位数字 CSPRNG：randomInt(0,1_000_000) 左补零。 */
export function pairingCode():string{
 return String(randomInt(0,1_000_000)).padStart(6,'0')
}

function sameCode(a:string,b:string):boolean{
 const left=Buffer.from(a),right=Buffer.from(b)
 return left.length===right.length&&timingSafeEqual(left,right)
}

export function createPairingService(deps:PairingDeps){
 const codes=new Map<string,{code:string;expiresAt:number;failures:number}>()
 const failures=new Map<string,{count:number;lockedUntil?:number}>()

 const active=(channelId:string)=>{
  const entry=codes.get(channelId)
  if(entry&&deps.now()>=entry.expiresAt){codes.delete(channelId);return undefined}
  return entry
 }

 return {
  create(channelId:string):{code:string;expiresAt:string}{
   const code=deps.random()
   if(!codePattern.test(code))throw new Error('配对码随机源返回了非 6 位数字。')
   const expiresAt=deps.now()+codeTtlMs
   codes.set(channelId,{code,expiresAt,failures:0})
   return {code,expiresAt:new Date(expiresAt).toISOString()}
  },
  redeem(input:{channelId:string;imUserId:string;chatId?:string;code:string;chatKind:ImChatKind;alreadyBound:boolean}):RedeemResult{
   // 群里出现过的有效码已公开：码对上才作废；错码不动码、不计错（否则群里任何人都能作废本人的码）。
   if(input.chatKind!=='direct'){
    const entry=active(input.channelId)
    if(entry&&sameCode(entry.code,input.code))codes.delete(input.channelId)
    return {kind:'not-in-direct'}
   }
   if(input.alreadyBound)return {kind:'already-bound'}
   const now=deps.now()
   const key=`${input.channelId}\n${input.imUserId}`
   const record=failures.get(key)
   if(record?.lockedUntil!==undefined){
    if(now<record.lockedUntil)return {kind:'locked',until:record.lockedUntil}
    failures.delete(key)
   }
   const entry=active(input.channelId)
   if(entry&&sameCode(entry.code,input.code)){
    codes.delete(input.channelId)
    failures.delete(key)
    return {kind:'bound'}
   }
   if(entry&&(entry.failures+=1)>=maxCodeFailures){
    codes.delete(input.channelId)
    // 审计失败不影响作废。
    void deps.audit?.record({at:new Date(now).toISOString(),channelId:input.channelId,chatId:input.chatId??'',imUserId:input.imUserId,action:'pair-rejected',result:'code-exhausted'}).catch(()=>{})
   }
   const count=(failures.get(key)?.count??0)+1
   failures.delete(key)
   if(failures.size>=failureLimit)failures.delete(failures.keys().next().value!)
   failures.set(key,count>=maxFailures?{count,lockedUntil:now+lockMs}:{count})
   return {kind:'invalid'}
  },
  invalidate(channelId:string):void{
   codes.delete(channelId)
  },
  peek(channelId:string):{expiresAt:string}|undefined{
   const entry=active(channelId)
   return entry?{expiresAt:new Date(entry.expiresAt).toISOString()}:undefined
  },
 }
}
