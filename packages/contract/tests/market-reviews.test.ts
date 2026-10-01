import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {WorkError} from '../src/work-error.ts'
import {marketReviewEntryId,checkMarketReviewInput,readMarketRatings,readMarketReviewPage,readMarketOwnReview,readMarketAccountStatus,readMarketLinkStart,readMarketLinkPoll,marketSignature,MARKET_REVIEW_BODY_MAX,MARKET_NICKNAME_MAX,MARKET_GITHUB_LOGIN} from '../src/market-reviews.ts'

// 与 market-worker/tests/protocol.test.mjs 共用同一张用例表：服务端归一后接受的值，契约读取器必须接受；服务端拒绝的形态，契约同样拒绝。
const cases=JSON.parse(await readFile(new URL('../../../tests/fixtures/public-protocol-cases.json',import.meta.url),'utf8'))
const invalid=(fn:()=>unknown,label:string)=>assert.throws(fn,(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-host-response',label)
const AT='2026-09-27T01:02:03.004Z'
const uuid=(n:number)=>`ffffffff-0000-4000-8000-${String(n).padStart(12,'0')}`
const item=(n:number,rating:number,extra:Record<string,unknown>={})=>({id:uuid(n),nickname:'小明',rating,body:'',entryVersion:'1.0.0',createdAt:AT,updatedAt:AT,reply:null,...extra})
const own=(extra:Record<string,unknown>)=>readMarketOwnReview({review:{id:uuid(1),rating:5,body:'',entryVersion:'1.0.0',status:'visible',createdAt:AT,updatedAt:AT,...extra}})
const page=(items:unknown[],count:number,avg:number|null,nextCursor:string|null=null)=>readMarketReviewPage({entryId:'teloa.soc',count,avg,claimedBy:null,items,nextCursor})

test('一致性：条目 ID、版本、用户码与 Worker 同一规则',()=>{
 for(const ok of cases.entryIds.ok)assert.ok(marketReviewEntryId.test(ok),ok)
 for(const bad of cases.entryIds.bad)assert.ok(!marketReviewEntryId.test(bad),bad)
 for(const ok of cases.versions.ok)assert.equal(own({entryVersion:ok})?.entryVersion,ok)
 for(const bad of cases.versions.bad)invalid(()=>own({entryVersion:bad}),bad)
 const link=(userCode:string)=>readMarketLinkStart({userCode,verificationUri:'https://market.teloa.ai/account/?code='+userCode,expiresAt:AT,interval:10})
 for(const ok of cases.userCodes.ok)assert.equal(link(ok).userCode,ok)
 for(const bad of cases.userCodes.bad)invalid(()=>link(bad),JSON.stringify(bad))
})

test('一致性：已归一昵称与正文两端同判；控制符与双向控制符全部拒绝；制表符与换行只在正文保留',()=>{
 assert.equal(MARKET_NICKNAME_MAX,24);assert.equal(MARKET_REVIEW_BODY_MAX,2000)
 const account=(nickname:string)=>readMarketAccountStatus({linked:true,nickname,provider:'email'})
 for(const ok of cases.nicknames.ok)assert.deepEqual(account(ok),{linked:true,nickname:ok,provider:'email'})
 for(const bad of cases.nicknames.bad)invalid(()=>account(bad),JSON.stringify(bad))
 for(const ok of cases.bodies.ok){
  assert.equal(own({body:ok})?.body,ok,JSON.stringify(ok))
  assert.deepEqual(checkMarketReviewInput({rating:5,body:ok}),{rating:5,body:ok})
 }
 for(const bad of cases.bodies.bad)invalid(()=>own({body:bad}),JSON.stringify(bad))
 // 服务端会归一的输入，契约只接受归一结果、拒绝原始输入
 for(const [input,target] of cases.nicknames.normalize as [string,string][]){invalid(()=>account(input),JSON.stringify(input));assert.equal(account(target).linked&&target,target)}
 for(const [input,target] of cases.bodies.normalize as [string,string][]){invalid(()=>own({body:input}),JSON.stringify(input));assert.equal(own({body:target})?.body,target)}
 for(const ch of cases.controlChars){
  invalid(()=>own({body:`a${ch}b`}),JSON.stringify(ch))
  invalid(()=>account(`小${ch}明`),JSON.stringify(ch))
  assert.throws(()=>checkMarketReviewInput({rating:5,body:`a${ch}b`}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input')
 }
 for(const ch of cases.bodyWhitespaceKept)assert.equal(own({body:`a${ch}b`})?.body,`a${ch}b`)
 // 词表与 NFKC 防冒充只在服务端执行；读取器对这些值不额外设限（服务端不会发出它们）
 for(const body of cases.serverStricterBodies)assert.equal(own({body})?.body,body)
 for(const nickname of cases.serverStricterNicknames)assert.deepEqual(account(nickname),{linked:true,nickname,provider:'email'})
 // 客户端预检不含词表：由服务端以 invalid_input 拒绝
 for(const body of cases.serverStricterBodies)assert.equal(checkMarketReviewInput({rating:5,body}).body,body)
})

test('一致性：Worker 的一位小数均分（.5 进位）全部落在契约可达区间；分页 20 条；游标形态一致',()=>{
 for(const [count,sum,avg] of cases.averages as [number,number,number][]){
  const ratings:number[]=Array.from({length:count},(_,at)=>1+Math.min(4,Math.max(0,Math.floor((sum-count)/count)+(at<(sum-count)%count?1:0))))
  assert.equal(ratings.reduce((a,b)=>a+b,0),sum)
  assert.deepEqual(readMarketRatings({enabled:true,asOf:AT,entries:[{id:'teloa.soc',count,avg}]}).entries,[{id:'teloa.soc',count,avg}],`${sum}/${count}`)
  const result=page(ratings.map((rating,at)=>item(count-at,rating)),count,avg)
  assert.equal(result.avg,avg);assert.equal(result.count,count)
 }
 // 不是 .5 进位得到的均分被拒绝：5/4 星合计 5 → 1.3，不是 1.2
 invalid(()=>readMarketRatings({enabled:true,asOf:AT,entries:[{id:'teloa.soc',count:4,avg:1.2}]}),'1.2')
 assert.equal(cases.pageSize,20)
 const full=Array.from({length:20},(_,at)=>item(40-at,5))
 const {updatedAt,id,value}=cases.cursor
 assert.equal(value,`${Date.parse(updatedAt)}.${id}`)
 const last={...full[19]!,id,updatedAt}
 assert.equal(page([...full.slice(0,19),last],21,5,value).nextCursor,value)
 invalid(()=>page([...full.slice(0,19),last],21,5,`${Date.parse(updatedAt)+1}.${id}`),'游标不符')
 invalid(()=>page([...full,item(0,5)],21,5),'超过 20 条')
 invalid(()=>page(full.slice(0,19),21,5,value),'短页不能有下一页')
})

test('宿主回包严格读取：多余字段、令牌字段、坏回复、坏游标、外站连接地址一律拒绝',()=>{
 const reply={by:'author',name:'acme',body:'谢谢',createdAt:'2026-09-27T02:00:00.000Z'}
 const one={entryId:'teloa.soc',count:1,avg:5,claimedBy:'acme',items:[item(1,5,{reply})],nextCursor:null}
 assert.deepEqual(readMarketReviewPage(one),one)
 for(const bad of [{...one,extra:1},{...one,avg:null},{...one,count:0},{...one,items:[item(1,5,{createdAt:'2026-09-27'})]},{...one,items:[item(1,6)]},{...one,items:[item(1,5,{reply:{...reply,by:'admin'}})]},{...one,items:[item(1,5,{token:'tmkt_x'})]},{...one,nextCursor:'x'}])
  invalid(()=>readMarketReviewPage(bad),JSON.stringify(bad))
 invalid(()=>readMarketRatings({enabled:true,asOf:null,entries:[{id:'teloa.soc',count:2,avg:0}]}),'avg 0')
 invalid(()=>readMarketRatings({enabled:false,asOf:null,entries:[{id:'teloa.soc',count:1,avg:5}]}),'未启用却有条目')
 assert.equal(readMarketOwnReview({review:null}),null)
 invalid(()=>readMarketOwnReview({review:{id:'x'}}),'残缺本人评价')
 invalid(()=>own({token:'tmkt_x'}),'本人评价带令牌')
 assert.deepEqual(readMarketAccountStatus({linked:false}),{linked:false})
 invalid(()=>readMarketAccountStatus({linked:true,nickname:'小明',provider:'email',token:'tmkt_x'}),'账号带令牌')
 invalid(()=>readMarketAccountStatus({linked:false,nickname:'小明'}),'未连接带昵称')
 const start={userCode:'BCDF-GHJK',verificationUri:'https://market.teloa.ai/account/?code=BCDF-GHJK',expiresAt:AT,interval:10}
 assert.deepEqual(readMarketLinkStart(start),start)
 invalid(()=>readMarketLinkStart({...start,verificationUri:'https://evil.example/?code=BCDF-GHJK'}),'外站地址')
 invalid(()=>readMarketLinkStart({...start,deviceCode:'d'.repeat(43)}),'设备码外泄')
 for(const status of ['idle','pending','denied','expired'])assert.deepEqual(readMarketLinkPoll({status}),{status})
 assert.deepEqual(readMarketLinkPoll({status:'linked',nickname:'小明',provider:'github'}),{status:'linked',nickname:'小明',provider:'github'})
 for(const bad of [{status:'approved',token:'tmkt_x'},{status:'pending',token:'tmkt_x'},{status:'linked',nickname:'小明',provider:'github',token:'tmkt_x'},{status:'linked',nickname:'小明',provider:'gitlab'}])
  invalid(()=>readMarketLinkPoll(bad),JSON.stringify(bad))
})

test('星级分布：可选键，存在时五档齐全、合计等于 count、按分布算的均分等于 avg、当前页每档条数不超过分布；空正文评价只计分布不进列表',()=>{
 const base={entryId:'teloa.soc',count:8,avg:3,claimedBy:null,nextCursor:null}
 const spread={1:1,2:3,3:1,4:1,5:2}
 const items=[item(5,5,{body:'好'}),item(4,5,{body:'好'}),item(3,4,{body:'好'}),item(2,3,{body:'好'}),item(1,1,{body:'好'})]
 const read=readMarketReviewPage({...base,distribution:spread,items})
 assert.deepEqual(read.distribution,spread);assert.equal(read.items.length,5)
 assert.equal('distribution' in readMarketReviewPage({...base,items}),false,'旧回包没有分布键，读出结果也不带')
 assert.deepEqual(readMarketReviewPage({entryId:'teloa.soc',count:0,avg:null,distribution:{1:0,2:0,3:0,4:0,5:0},claimedBy:null,items:[],nextCursor:null}).distribution,{1:0,2:0,3:0,4:0,5:0})
 for(const bad of [
  {1:1,2:3,3:1,4:1},                 // 缺档
  {...spread,6:0},                   // 多档
  {...spread,5:3},                   // 合计不等于 count
  {1:2,2:2,3:1,4:1,5:2},             // 合计对但均分对不上（2.9）
  {...spread,1:-1,2:5},              // 负数
  {...spread,1:1.5,2:2.5},           // 非整数
  {...spread,1:'1'},                 // 非数字
  [1,3,1,1,2],                       // 数组
 ])invalid(()=>readMarketReviewPage({...base,distribution:bad,items}),JSON.stringify(bad))
 // 当前页 1 星有 2 条，分布里 1 星只有 1 条
 invalid(()=>readMarketReviewPage({entryId:'teloa.soc',count:8,avg:3,distribution:spread,claimedBy:null,items:[item(2,1,{body:'差'}),item(1,1,{body:'差'})],nextCursor:null}),'页内条数超过分布')
 invalid(()=>readMarketReviewPage({entryId:'teloa.soc',count:0,avg:null,distribution:{1:1,2:0,3:0,4:0,5:0},claimedBy:null,items:[],nextCursor:null}),'空条目分布非零')
})

test('公开署名：GitHub 用户名（含保留词、1 字、最长 39 字）在评价列表与 GitHub 账号状态中被接受；邮箱账号仍按昵称规则',()=>{
 for(const ok of cases.githubLogins.ok as string[]){
  assert.ok(MARKET_GITHUB_LOGIN.test(ok),ok)
  assert.equal(page([item(1,5,{nickname:ok})],1,5).items[0]!.nickname,ok)
  assert.deepEqual(readMarketAccountStatus({linked:true,nickname:ok,provider:'github'}),{linked:true,nickname:ok,provider:'github'})
  assert.deepEqual(readMarketLinkPoll({status:'linked',nickname:ok,provider:'github'}),{status:'linked',nickname:ok,provider:'github'})
 }
 for(const bad of cases.githubLogins.bad as string[])assert.ok(!MARKET_GITHUB_LOGIN.test(bad),JSON.stringify(bad))
 // 既不是 GitHub 用户名也不是合规昵称：两处都拒绝
 for(const bad of ['','@a','a\u202e','x'.repeat(40)]){
  invalid(()=>page([item(1,5,{nickname:bad})],1,5),JSON.stringify(bad))
  invalid(()=>readMarketAccountStatus({linked:true,nickname:bad,provider:'github'}),JSON.stringify(bad))
 }
 // 邮箱账号不放宽：保留词与单字仍拒绝
 for(const bad of ['sys-admin','Teloa','a'])invalid(()=>readMarketAccountStatus({linked:true,nickname:bad,provider:'email'}),bad)
 invalid(()=>readMarketLinkPoll({status:'linked',nickname:'sys-admin',provider:'email'}),'邮箱账号保留词')
})

test('应用连接地址：账号页（旧）与连接确认页 /account/connect/（新）都接受，只认本次用户码',()=>{
 const start=(verificationUri:string)=>readMarketLinkStart({userCode:'BCDF-GHJK',verificationUri,expiresAt:AT,interval:10})
 assert.equal(start('https://market.teloa.ai/account/?code=BCDF-GHJK').verificationUri,'https://market.teloa.ai/account/?code=BCDF-GHJK')
 assert.equal(start('https://market.teloa.ai/account/connect/?code=BCDF-GHJK').verificationUri,'https://market.teloa.ai/account/connect/?code=BCDF-GHJK')
 for(const bad of ['https://market.teloa.ai/account/connect/?code=BCDF-GHJX','https://market.teloa.ai/account/connect?code=BCDF-GHJK','https://evil.example/account/connect/?code=BCDF-GHJK','https://market.teloa.ai/account/admin/?code=BCDF-GHJK'])
  invalid(()=>start(bad),bad)
})

test('账号状态的审核方式：已连接时可带 moderation（只认 pre、post）；未连接不得带；连接轮询结果不带',()=>{
 assert.deepEqual(readMarketAccountStatus({linked:true,nickname:'xm',provider:'github',moderation:'pre'}),{linked:true,nickname:'xm',provider:'github',moderation:'pre'})
 assert.deepEqual(readMarketAccountStatus({linked:true,nickname:'xm',provider:'github',moderation:'post'}),{linked:true,nickname:'xm',provider:'github',moderation:'post'})
 assert.deepEqual(readMarketAccountStatus({linked:true,nickname:'xm',provider:'github'}),{linked:true,nickname:'xm',provider:'github'})
 for(const bad of ['auto','',null,1,'PRE'])invalid(()=>readMarketAccountStatus({linked:true,nickname:'xm',provider:'github',moderation:bad}),JSON.stringify(bad))
 invalid(()=>readMarketAccountStatus({linked:false,moderation:'pre'}),'未连接带审核方式')
 invalid(()=>readMarketLinkPoll({status:'linked',nickname:'xm',provider:'github',moderation:'pre'}),'轮询带审核方式')
})

test('界面署名：GitHub 账号写 @用户名、邮箱账号写昵称；只有名字时按 GitHub 用户名形态判断',()=>{
 assert.equal(marketSignature('octo-cat','github'),'@octo-cat')
 assert.equal(marketSignature('小明','email'),'小明')
 assert.equal(marketSignature('octo','email'),'octo')
 assert.equal(marketSignature('octo-cat'),'@octo-cat')
 assert.equal(marketSignature('小明'),'小明')
 assert.equal(marketSignature('Max Tester'),'Max Tester')
})
