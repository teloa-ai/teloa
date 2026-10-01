import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {externalEgressToolAllowed,externalEgressTools,roleGrantToolNames,referenceReadTool,subagentTaskToolName,unconstrainedGrantToolNames,validateReferenceToolRules,webToolRules,type WebGatePolicy} from '../src/role-tool-grants.ts'

// 四参真值表逐条钉死。判据函数本身不碰 URL 解析：`hostAllowed` 是调用方算好的布尔（编排者裁定 2）。
const rows:{policy:WebGatePolicy|undefined;businessBound:boolean;allowedTools:readonly string[]|null;fetch:boolean;search:boolean}[]=[
 // 策略读不到就是判不出来：与「绑定了业务来源」同权，两个工具一律拒（不变式 2）。
 {policy:undefined,businessBound:false,allowedTools:['web_fetch','web_search'],fetch:false,search:false},
 {policy:undefined,businessBound:true,allowedTools:['web_fetch','web_search'],fetch:false,search:false},
 {policy:undefined,businessBound:false,allowedTools:null,fetch:false,search:false},
 // 总开关关：任何会话、任何授权都拒。
 {policy:{enabled:false,hostAllowed:true},businessBound:false,allowedTools:null,fetch:false,search:false},
 {policy:{enabled:false,hostAllowed:true},businessBound:true,allowedTools:['web_fetch','web_search'],fetch:false,search:false},
 // 黑名单是目标侧概念：只拦 web_fetch，对 web_search 不生效。
 {policy:{enabled:true,hostAllowed:false},businessBound:false,allowedTools:null,fetch:false,search:true},
 {policy:{enabled:true,hostAllowed:false},businessBound:true,allowedTools:['web_fetch','web_search'],fetch:false,search:true},
 // 本人在场的普通会话（未绑定业务来源）：与今天一致，两个都放行。
 {policy:{enabled:true,hostAllowed:true},businessBound:false,allowedTools:null,fetch:true,search:true},
 // 绑定了业务来源：回到显式授权判断，普通会话没有清单即拒。
 {policy:{enabled:true,hostAllowed:true},businessBound:true,allowedTools:null,fetch:false,search:false},
 {policy:{enabled:true,hostAllowed:true},businessBound:true,allowedTools:['web_fetch'],fetch:true,search:false},
]

test('externalEgressToolAllowed 的四参真值表逐条成立',()=>{
 for(const row of rows){
  const label=JSON.stringify(row)
  assert.equal(externalEgressToolAllowed(row.allowedTools,'web_fetch',row.businessBound,row.policy),row.fetch,label)
  assert.equal(externalEgressToolAllowed(row.allowedTools,'web_search',row.businessBound,row.policy),row.search,label)
 }
 // 非外发工具名恒放行：第一行 early return 不变，别的闸自己说话。
 for(const name of ['read_evidence',referenceReadTool,subagentTaskToolName,'workflow'])
  for(const row of rows)assert.equal(externalEgressToolAllowed(row.allowedTools,name,row.businessBound,row.policy),true)
})

test('拦截名单对 web_search 不生效：同一组入参下 hostAllowed 两值同答',()=>{
 for(const businessBound of [false,true])for(const allowedTools of [null,['web_search'],['web_fetch']]){
  const blocked=externalEgressToolAllowed(allowedTools,'web_search',businessBound,{enabled:true,hostAllowed:false})
  const open=externalEgressToolAllowed(allowedTools,'web_search',businessBound,{enabled:true,hostAllowed:true})
  assert.equal(blocked,open)
 }
})

test('webToolRules 按总开关产出候选：开则恰两条整工具规则，关则无可勾项',()=>{
 assert.deepEqual(webToolRules(true),[{name:'web_fetch',anyArguments:true,allowed:[]},{name:'web_search',anyArguments:true,allowed:[]}])
 assert.deepEqual(webToolRules(true).map(rule=>rule.name),[...externalEgressTools])
 assert.deepEqual(webToolRules(false),[])
})

test('外发与编排各自进入显式岗位授权固定集',()=>{
 for(const name of externalEgressTools){
  assert.ok(roleGrantToolNames.includes(name))
  assert.ok(unconstrainedGrantToolNames.includes(name))
 }
 for(const name of ['workflow','ralph','run_code']){
  assert.ok(roleGrantToolNames.includes(name))
  assert.ok(unconstrainedGrantToolNames.includes(name))
 }
})

test('两名只能整工具授权：anyArguments 通过，按参数授权逐字被拒',()=>{
 const available=webToolRules(true)
 for(const name of externalEgressTools)validateReferenceToolRules([{name,anyArguments:true,allowed:[]}],available)
 validateReferenceToolRules(webToolRules(true),available)
 assert.throws(()=>validateReferenceToolRules([{name:'web_fetch',allowed:[{url:'https://x'}]}],available),error=>{
  assert.equal((error as {code?:string}).code,'teloa/forbidden')
  assert.equal((error as Error).message,'参数不可枚举的工具只能整工具授权，不接受按参数授权。')
  return true
 })
})

test('总开关关掉后已保存的上网授权必须被判拒，不只是授权页少两个可勾项',()=>{
 // 候选来自 `webToolRules(false)`（空），但规则里仍留着之前保存的整工具授权。
 for(const name of externalEgressTools)assert.throws(()=>validateReferenceToolRules([{name,anyArguments:true,allowed:[]}],webToolRules(false)),error=>{
  assert.equal((error as {code?:string}).code,'teloa/forbidden')
  assert.equal((error as Error).message,'只能授权员工已选资料、已连接行业工具或已登记的技能接口代发。')
  return true
 })
 // 逃生口只留给 `subagent_task`：它的候选由 `taskRunToolRules` 无条件补齐，不受任何设置开关影响。
 validateReferenceToolRules([{name:subagentTaskToolName,anyArguments:true,allowed:[]}],[])
 // 总开关开着时同一条规则照常通过——被拒的原因确实是总开关，不是这条规则本身。
 for(const name of externalEgressTools)validateReferenceToolRules([{name,anyArguments:true,allowed:[]}],webToolRules(true))
})

// D-1：`recheck`（执行面复核）不再随上网总开关判授权，总开关只由 `task-tool-guard` 闸①执行
// （逐字理由「设置中已关闭网页搜索与读取。」）。`recheck` 定义在 `index.ts` 的 `apply()` 闭包里，
// 用到 `context.db`/`industryMcpToolRules` 等只在装配期才有的依赖，无法在这里单独构造调用；
// 改为源码守卫：钉死 `recheck` 那一行的候选恒是 `webToolRules(true)`，不再读 `webAccessPolicy(...).enabled`。
// 真正的行为验证见 `同事上网真实链路.test.ts` 第 11 步「不暂停任何同事即刻生效」。
test('index.ts 的 roleGrants.recheck 恒以 webToolRules(true) 为上网候选，不随总开关降级',()=>{
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')
 const start=source.indexOf('recheck:async(run,target,context)=>{')
 assert.ok(start>=0,'index.ts 里找不到 recheck 的定义')
 const end=source.indexOf('},',start)
 const body=source.slice(start,end)
 assert.match(body,/webToolRules\(true\)/,'recheck 的候选必须恒为 webToolRules(true)')
 assert.doesNotMatch(body,/webAccessPolicy\(context\.db\)\)\.enabled/,'recheck 不应再读总开关来决定上网候选')
})

// H1：`validate` 与 `recheck` 取齐。两者都在**运行准备**路径上核对岗位已保存的 `argumentRules`，
// 上网候选恒为 `webToolRules(true)`。曾经 `validate` 读总开关：关掉后候选为空，带上网授权的同事
// 连一次 `task-runs/prepare` 都跑不起来（整次准备抛 `teloa/forbidden`「只能授权员工已选资料、已连接行业工具或已登记的技能接口代发。」）。
// 授权页那一支（`grantRules.build()`）仍随总开关走，不在本条取齐的范围内，这里一并钉住别被误改。
test('index.ts 的 roleGrants.validate 与 recheck 取齐：上网候选恒为 webToolRules(true)',()=>{
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')
 const start=source.indexOf('validate:async(rules,knowledge,context)=>')
 assert.ok(start>=0,'index.ts 里找不到 validate 的定义')
 const body=source.slice(start,source.indexOf('\n',start))
 assert.match(body,/webToolRules\(true\)/,'validate 的候选必须恒为 webToolRules(true)')
 assert.doesNotMatch(body,/webAccessPolicy/,'validate 不应再读总开关来决定上网候选')
 assert.match(source,/webToolRules\(\(await webAccessPolicy\(db\)\)\.enabled\)/,'授权页候选（grantRules）仍应随总开关走')
})
