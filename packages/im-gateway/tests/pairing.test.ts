import test from 'node:test'
import assert from 'node:assert/strict'
import {createPairingService,pairingCode} from '../src/core/pairing.ts'

const t0=Date.parse('2026-09-26T00:00:00Z')

function service(codes:string[]=['123456','654321','111111','222222']){
 let now=t0
 const queue=[...codes]
 const pairing=createPairingService({now:()=>now,random:()=>queue.shift()!})
 return {pairing,advance:(ms:number)=>{now+=ms},now:()=>now}
}

const direct=(code:string,imUserId='u1')=>({channelId:'telegram',imUserId,code,chatKind:'direct' as const,alreadyBound:false})

test('pairingCode：6 位数字（CSPRNG 取值左补零）',()=>{
 for(let i=0;i<50;i+=1)assert.match(pairingCode(),/^\d{6}$/)
})

test('1. create 返回 6 位数字、expiresAt=now+600 s；同渠道再次 create 后旧码 invalid',()=>{
 const {pairing}=service()
 const first=pairing.create('telegram')
 assert.match(first.code,/^\d{6}$/)
 assert.equal(first.expiresAt,new Date(t0+600_000).toISOString())
 const second=pairing.create('telegram')
 assert.notEqual(second.code,first.code)
 assert.deepEqual(pairing.redeem(direct(first.code)),{kind:'invalid'})
 assert.deepEqual(pairing.redeem(direct(second.code)),{kind:'bound'})
})

test('随机源给出非 6 位数字 → create 抛错，不产生有效码',()=>{
 const {pairing}=service(['12345'])
 assert.throws(()=>pairing.create('telegram'))
 assert.equal(pairing.peek('telegram'),undefined)
})

test('2. 正确码 → bound；同码再用 → invalid（一次性）',()=>{
 const {pairing}=service()
 const {code}=pairing.create('telegram')
 assert.deepEqual(pairing.redeem(direct(code)),{kind:'bound'})
 assert.deepEqual(pairing.redeem(direct(code,'u2')),{kind:'invalid'})
})

test('3. 推进 601 s 后 → invalid（过期）；peek 不再返回',()=>{
 const {pairing,advance}=service()
 const {code}=pairing.create('telegram')
 advance(601_000)
 assert.deepEqual(pairing.redeem(direct(code)),{kind:'invalid'})
 assert.equal(pairing.peek('telegram'),undefined)
})

test('4. 连续错 5 次（第 5 次仍回 invalid）→ 第 6 次含正确码 locked，until=第 5 次时刻+900 s；900 s 后新码 bound；其他用户不受影响',()=>{
 const {pairing,advance,now}=service()
 const {code}=pairing.create('telegram')
 let fifth=0
 for(let i=0;i<5;i+=1){
  advance(1000)
  if(i===4)fifth=now()
  assert.deepEqual(pairing.redeem(direct('000000')),{kind:'invalid'})
 }
 assert.deepEqual(pairing.redeem(direct(code)),{kind:'locked',until:fifth+900_000})
 assert.deepEqual(pairing.redeem(direct('000000')),{kind:'locked',until:fifth+900_000},'锁内错码不延长锁')
 advance(899_000)
 assert.equal(pairing.redeem(direct(code)).kind,'locked')
 advance(1000)
 const fresh=pairing.create('telegram')
 assert.deepEqual(pairing.redeem(direct(fresh.code)),{kind:'bound'})
})

test('错码计数按 (channelId,imUserId) 隔离；成功后清零',()=>{
 const {pairing}=service()
 const {code}=pairing.create('telegram')
 for(let i=0;i<4;i+=1)pairing.redeem(direct('000000'))
 assert.deepEqual(pairing.redeem(direct(code,'u2')),{kind:'bound'})
 const next=pairing.create('telegram')
 assert.deepEqual(pairing.redeem(direct(next.code)),{kind:'bound'})
 const again=pairing.create('telegram')
 for(let i=0;i<4;i+=1)assert.deepEqual(pairing.redeem(direct('000000')),{kind:'invalid'})
 assert.deepEqual(pairing.redeem(direct(again.code)),{kind:'bound'},'上次成功已清零，本轮 4 次错码不触发锁')
})

test('5. 群内发有效码 → not-in-direct 且该渠道码立即作废；随后私聊同码 invalid',()=>{
 const {pairing}=service()
 const {code}=pairing.create('telegram')
 assert.deepEqual(pairing.redeem({...direct(code),chatKind:'group'}),{kind:'not-in-direct'})
 assert.equal(pairing.peek('telegram'),undefined)
 assert.deepEqual(pairing.redeem(direct(code)),{kind:'invalid'})
 const threaded=pairing.create('telegram')
 assert.deepEqual(pairing.redeem({...direct(threaded.code),chatKind:'thread'}),{kind:'not-in-direct'})
})

test('L1. 群内发错码 → not-in-direct 但不作废、不计错码；随后私聊正确码 bound',()=>{
 const {pairing}=service()
 const {code}=pairing.create('telegram')
 const wrong=code==='000000'?'111111':'000000'
 for(let i=0;i<25;i+=1)assert.deepEqual(pairing.redeem({...direct(wrong),chatKind:'group'}),{kind:'not-in-direct'})
 assert.ok(pairing.peek('telegram'))
 assert.deepEqual(pairing.redeem(direct(code)),{kind:'bound'})
})

test('6. alreadyBound → already-bound 且不消费码；随后新用户同码 bound',()=>{
 const {pairing}=service()
 const {code}=pairing.create('telegram')
 assert.deepEqual(pairing.redeem({...direct(code),alreadyBound:true}),{kind:'already-bound'})
 assert.deepEqual(pairing.redeem(direct(code,'u2')),{kind:'bound'})
})

test('渠道隔离：另一渠道的码不能兑换本渠道；invalidate 只作废指定渠道',()=>{
 const {pairing}=service()
 const tg=pairing.create('telegram')
 const slack=pairing.create('slack')
 assert.deepEqual(pairing.redeem({...direct(slack.code),channelId:'telegram'}),{kind:'invalid'})
 pairing.invalidate('slack')
 assert.equal(pairing.peek('slack'),undefined)
 assert.deepEqual(pairing.redeem(direct(tg.code)),{kind:'bound'})
})

test('peek 只回 expiresAt，不回码',()=>{
 const {pairing}=service()
 const created=pairing.create('telegram')
 assert.deepEqual(pairing.peek('telegram'),{expiresAt:created.expiresAt})
 assert.equal(pairing.peek('feishu'),undefined)
})

test('全局失败上限：换 5 个账号各试 4 次（累计 20 次）→ 该码作废，审计记一条且不含码值；正确码随后 invalid',async()=>{
 let now=t0
 const rows:Record<string,unknown>[]=[]
 const pairing=createPairingService({now:()=>now,random:()=>'123456',audit:{record:async row=>{rows.push(row)}}})
 const {code}=pairing.create('telegram')
 for(let user=0;user<5;user+=1){
  for(let i=0;i<4;i+=1){
   now+=1000
   assert.deepEqual(pairing.redeem({...direct('000000',`u${user}`),chatId:`c${user}`}),{kind:'invalid'})
   if(user*4+i<19)assert.ok(pairing.peek('telegram'),`第 ${user*4+i+1} 次后码仍有效`)
  }
 }
 assert.equal(pairing.peek('telegram'),undefined)
 assert.deepEqual(pairing.redeem(direct(code,'u9')),{kind:'invalid'})
 await Promise.resolve()
 assert.equal(rows.length,1)
 assert.deepEqual(rows[0],{at:new Date(now).toISOString(),channelId:'telegram',chatId:'c4',imUserId:'u4',action:'pair-rejected',result:'code-exhausted'})
 assert.ok(!JSON.stringify(rows).includes(code))
})

test('全局失败计数随新码清零：19 次失败后新建码，再错 19 次仍有效',()=>{
 let now=t0
 const pairing=createPairingService({now:()=>now,random:()=>'123456'})
 pairing.create('telegram')
 for(let i=0;i<19;i+=1)pairing.redeem(direct('000000',`u${i}`))
 assert.ok(pairing.peek('telegram'))
 pairing.create('telegram')
 for(let i=0;i<19;i+=1)pairing.redeem(direct('000000',`v${i}`))
 assert.ok(pairing.peek('telegram'))
 assert.deepEqual(pairing.redeem(direct('123456','w')),{kind:'bound'})
})
