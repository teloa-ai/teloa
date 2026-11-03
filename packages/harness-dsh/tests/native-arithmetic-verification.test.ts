import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {createUserMessage,ToolCallId,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {arithmeticValue,assessArithmetic} from '../src/native-arithmetic-verification.ts'
import {nativeHotCausalityFixture} from './fixtures/native-hot-causality.ts'

const answer=(text:string):readonly StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text},{type:'block-end',index:0,block:{type:'text',text}},{type:'finish',reason:{kind:'stop'}}]
const call=(name='calculator',id='calculation',args:Record<string,unknown>=name==='calculator'?{expression:'17+28'}:{}):readonly StreamChunk[]=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:ToolCallId(id),name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(id),name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}]
const question='请计算本批总金额，核算所给数值。'
async function send(f:Awaited<ReturnType<typeof nativeHotCausalityFixture>>,id:string,target=f.agent,text=question){
 const message=createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text}]})
 await f.work.withNewInput(target,message,{producer:'prompt',identity:id},()=>target.followup(message));await target.whenIdle()
}
function calculator(f:Awaited<ReturnType<typeof nativeHotCausalityFixture>>){
 let executions=0
 f.ctx.tools.register(defineTool({name:'calculator',description:'本地独立加法工具；不访问模型或数据库',parameters:{expression:{type:'string',required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async args=>{
  assert.match(args.expression,/^\d+\+\d+$/);executions++;const [a,b]=args.expression.split('+').map(Number);return String(a!+b!)
 }}))
 return ()=>executions
}
const completed=(f:Awaited<ReturnType<typeof nativeHotCausalityFixture>>,target=f.agent)=>f.events(target).filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind==='completed'
const notices=(f:Awaited<ReturnType<typeof nativeHotCausalityFixture>>,target=f.agent)=>f.events(target).filter(event=>event.type==='user/message'&&event.data.source.kind==='plugin:teloa.arithmetic-verification')

test('长数字说明没有运算结果时也必须有界返回',{timeout:5000},async()=>{
 const moduleURL=new URL('../src/native-arithmetic-verification.ts',import.meta.url).href
 const script=`import {assessArithmetic} from ${JSON.stringify(moduleURL)}; const result=assessArithmetic('请阅读普通说明，不要求计算。','1 '.repeat(31999),[]); if(result!=='none')throw Error(result);`
 const child=spawn(process.execPath,['--input-type=module','--eval',script],{stdio:'ignore'})
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},2000)
 const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)}).finally(()=>clearTimeout(timer))
 assert.equal(timedOut,false,'扫描不能阻塞宿主事件循环');assert.equal(code,0)
})

test('原工具计算失败：文字连接和全角括号不能隐藏错误交叉校验',()=>{
 const receipt={name:'calculator',arguments:{expression:'72.60*100'},text:'7260'}
 for(const separator of ['得','得到','得出','等于','结果为','equals','yields']){
  assert.equal(assessArithmetic(question,`交叉校验：（72.60 × 100）${separator} 7266 分位基数检查通过，结果为7260分。`,[receipt]),'contradiction')
  assert.equal(assessArithmetic(question,`交叉校验：（72.60 × 100）${separator} 7260 分。`,[receipt]),'verified')
 }
 assert.equal(assessArithmetic(question,'计算方式：以分为单位（500×4 + 920×3 − 500 = 7260 分）。',[receipt]),'contradiction')
 assert.equal(assessArithmetic(question,'交叉校验：（2+3）×4得20。',[{name:'calculator',arguments:{expression:'(2+3)*4'},text:'20'}]),'verified')
 assert.equal(assessArithmetic('逐字引用原文','交叉校验：（72.60 × 100）得7266分。',[]),'none')
 assert.equal(assessArithmetic(question,'版本2026，记录编号7266，负责人45。',[]),'none')
 assert.equal(assessArithmetic(question,'SKU1+2=4',[]),'none')
 assert.equal(assessArithmetic(question,'Check 2+3=5',[{name:'calculator',arguments:{expression:'2+3'},text:'5'}]),'verified')
 for(const text of ['2+3\t=6','2+3=\n6'])assert.equal(assessArithmetic(question,text,[]),'contradiction')
 const longest='12345678'+'+1234567'.repeat(31)
 assert.equal(longest.length,256)
 assert.equal(assessArithmetic(question,`${longest} = 50617255`,[{name:'calculator',arguments:{expression:longest},text:'50617255'}]),'verified')
 assert.equal(assessArithmetic(question,`${longest}1 = 123`,[]),'none')
})

test('真实原生轮次：错误文字推导须纠正后才能完成',{timeout:15000},async t=>{
 const f=await nativeHotCausalityFixture(t),executions=calculator(f)
 f.adapter.scripts.push(call(),answer('合计45元。交叉校验：（45 × 100）得4506分。'),call('calculator','verify-cents',{expression:'4500+0'}),answer('合计45元。交叉校验：（45 × 100）得4500分。'))
 await send(f,'worded-calculation')
 assert.equal(executions(),2);assert.equal(notices(f).length,1);assert.ok(completed(f));assert.equal(f.adapter.requests.length,4)
})

test('peer P2：无关运算加常量输出不能证明该合计，Python/bash回执必须绑定唯一纯算式',()=>{
 for(const receipt of [
  {name:'python',arguments:{code:'print(1+1);print(113)'},text:'2\n113'},
  {name:'bash',arguments:{command:'python3 -c "print(1+1);print(113)"'},text:'2\n113'},
  {name:'python',arguments:{code:'print(1+1)'},text:'2\n113'},
  {name:'python',arguments:{code:'print(113)'},text:'113'},
  {name:'python',arguments:{code:'value=1+1\nprint(113)'},text:'113'},
  {name:'bash',arguments:{command:'echo 113; python3 -c "print(1+1)"'},text:'113\n2'},
  {name:'bash',arguments:{command:'python3 -c "print(1+1)"; echo 113'},text:'2\n113'},
  {name:'bash',arguments:{command:'echo "$((1+1))"; echo 113'},text:'2\n113'},
  {name:'run_code',arguments:{language:'python',code:'print(1+1)\nprint(113)'},text:'2\n113'},
 ])assert.equal(assessArithmetic('请计算50与54合计','合计113元',[receipt]),'missing')
 for(const [expression,result] of [['9*7','63'],['19+28','47'],['12.5*4','50'],['(8-3)*6','30'],['7/2','3.5']]){
  const receipt={name:'python',arguments:{code:`print(${expression})`},text:result!+'\n'}
  assert.equal(assessArithmetic(question,`合计${result}元`,[receipt]),'verified')
  assert.equal(assessArithmetic(question,`合计${result}元`,[{...receipt,text:result+'\n999'}]),'missing')
  assert.equal(assessArithmetic(question,'合计999元',[receipt]),'missing')
 }
 assert.equal(assessArithmetic(question,'合计0.3元',[{name:'python',arguments:{code:'print(0.1+0.2)'},text:'0.30000000000000004'}]),'missing','浮点近似不冒充精确十进制核验')
 assert.equal(assessArithmetic(question,'合计45元',[{name:'calculator',arguments:{expression:'17+28'},text:'45\n999'}]),'missing')
})

test('真实ToolRuntime多输出仍被拒绝，单一纯乘法输出可完成另一金额',{timeout:15000},async t=>{
 for(const poisoned of [true,false]){
  const f=await nativeHotCausalityFixture(t);let executions=0
  f.ctx.tools.register(defineTool({name:'python',description:'独立的本地计算体，无provider或PG',parameters:{code:{type:'string',required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async args=>{
   executions++
   if(args.code==='print(1+1);print(113)')return String(1+1)+'\n113'
   const match=args.code.match(/^print\((\d+)\*(\d+)\)$/);assert.ok(match);return String(Number(match[1])*Number(match[2]))
  }}))
  f.adapter.scripts.push(call('python','python-result',{code:poisoned?'print(1+1);print(113)':'print(9*7)'}),answer(poisoned?'合计113元':'合计63元'))
  if(poisoned)f.adapter.scripts.push(answer('合计113元，已完成。'))
  await send(f,'python-binding')
  assert.equal(executions,1);assert.equal(notices(f).length,poisoned?1:0);assert.equal(completed(f),!poisoned)
  assert.equal(f.adapter.requests.length,poisoned?3:2)
 }
})

test('精确四则核验不使用浮点近似；拒绝代码、指数、除零和超长输入',()=>{
 assert.equal(arithmeticValue('(0.1+0.2)*10'),'3/1');assert.equal(arithmeticValue('7/3'),'7/3');assert.equal(arithmeticValue('-2*(3+4)'),'-14/1')
 for(const text of ['1/0','1e6','process.exit()','1+'.repeat(200),'1.2.3'])assert.equal(arithmeticValue(text),undefined)
})
test('明确矛盾、没有实际计算与正确回执区分；日期/版本/引用/真实未知不误触发',()=>{
 assert.equal(assessArithmetic(question,'17 + 28 = 46',[]),'contradiction')
 assert.equal(assessArithmetic(question,'总金额：45 元。',[]),'missing')
 assert.equal(assessArithmetic(question,'总金额：45 元。',[{name:'bash',arguments:{command:'echo 45'},text:'45'}]),'missing')
 assert.equal(assessArithmetic(question,'总金额45元',[{name:'bash',arguments:{command:'python3 -c "print(\'45 + 0 = 45\')"'},text:'45 + 0 = 45'}]),'missing')
 assert.equal(assessArithmetic(question,'总金额45元',[{name:'bash',arguments:{command:'python3 -c "print(17+28)"'},text:'45'}]),'verified')
 assert.equal(assessArithmetic(question,'总金额45元',[{name:'bash',arguments:{command:"python3 - <<'PY'\nprint(17+28)\nPY"},text:'45'}]),'verified')
 assert.equal(assessArithmetic(question,'17+28=45；总金额45元',[{name:'calculator',arguments:{expression:'17+28'},text:'45'}]),'verified')
 for(const body of ['日期2026-11-03，版本1.2.3，编号12345。','total 2026-11-03；total 1.2.3。','> 17+28=46\n这是引用原文。','原文为“17+28=46”，未将引用当作本次结论。','例如17+28=46，但不是本轮计算。','总金额未知，单价未提供。'])assert.equal(assessArithmetic(question,body,[]),'none')
 assert.equal(assessArithmetic(question,'总金额45元；本次未执行计算核验，结果待核对。',[]),'unverified')
 assert.equal(assessArithmetic(question,'总金额45元；批次未知。',[]),'missing')
 assert.equal(assessArithmetic(question,'总金额45元，未执行计算核验，但已全部完成。',[]),'missing')
 assert.equal(assessArithmetic(question,'总金额45元',[{name:'calculator',arguments:{expression:'1+2'},text:'45'}]),'missing')
 assert.equal(assessArithmetic('请逐字引用原文，不做改写。','17+28=46',[]),'none')
 assert.equal(assessArithmetic('请读取已有记录的总金额。','总金额45元',[]),'none')
 assert.equal(assessArithmetic('核对本批：甲2件、乙3件。使用已保存单价给出总金额和件数。','总金额45元；件数5件',[]),'missing')
})
test('真实受管Loop在同turn追加唯一核验输入，实际工具计算后才能一致完成',{timeout:15000},async t=>{
 const f=await nativeHotCausalityFixture(t),count=calculator(f)
 f.adapter.scripts.push(answer('17+28=46；总金额46元'),call(),answer('17+28=45；总金额45元'))
 await send(f,'arithmetic-once')
 assert.equal(f.adapter.requests.length,3);assert.equal(count(),1);assert.equal(notices(f).length,1);assert.equal(completed(f),true)
 assert.equal(f.events().filter(event=>event.type==='turn/start').length,1)
 assert.equal(f.authorizations.filter(request=>request.kind==='native-input').length,1,'纠正继承原受理根，不伪造新请求')
 assert.ok(f.counters.continuationAssertions>0)
 assert.ok(f.adapter.requests.every(request=>request.provider==='hot-test'&&request.model==='hot-model'))
})
test('一次纠正仍缺计算回执时明确失败；NoCode可如实未核验收口，不强授工具',{timeout:15000},async t=>{
 for(const final of ['总金额45元，已完成。','未执行计算核验，金额仍待核对。']){
  const f=await nativeHotCausalityFixture(t)
  f.adapter.scripts.push(answer('总金额45元。'),answer(final));await send(f,'unverified',f.agent,question+'仅分析，不运行代码。')
  assert.equal(f.adapter.requests.length,2);assert.equal(notices(f).length,1);assert.equal(f.counters.tools,0)
  assert.equal(completed(f),final.startsWith('未执行'))
 }
})
test('已有本轮成功计算直接通过；另一会话或上一turn的真实回执不能借用',{timeout:20000},async t=>{
 const f=await nativeHotCausalityFixture(t),count=calculator(f)
 f.adapter.scripts.push(call(),answer('17+28=45；总金额45元'))
 await send(f,'other-calculated',f.other);assert.equal(completed(f,f.other),true);assert.equal(notices(f,f.other).length,0)
 f.adapter.scripts.push(answer('总金额45元'),answer('总金额45元'))
 await send(f,'foreign-receipt');assert.equal(completed(f),false);assert.equal(notices(f).length,1)
 f.adapter.scripts.push(call('calculator','fresh-calculation'),answer('17+28=45；总金额45元'))
 await send(f,'own-calculated');assert.equal(completed(f),true)
 f.adapter.scripts.push(answer('总金额45元'),answer('总金额45元'))
 await send(f,'old-turn-receipt');assert.equal(completed(f),false);assert.equal(count(),2)
})
test('纠正最多四个模型步骤，不能靠连续无关工具维持无限核验',{timeout:15000},async t=>{
 const f=await nativeHotCausalityFixture(t)
 f.adapter.scripts.push(answer('总金额45元'),...Array.from({length:4},(_,i)=>call('hot_result','unrelated-'+i)))
 await send(f,'bounded-correction');assert.equal(f.adapter.requests.length,5);assert.equal(notices(f).length,1);assert.equal(completed(f),false)
})
test('失败计算不能成为回执；TaskRun生产者保留原复核接缝，不启动普通prompt纠正',{timeout:15000},async t=>{
 const f=await nativeHotCausalityFixture(t)
 f.ctx.tools.register(defineTool({name:'calculator',description:'明确失败的计算工具',parameters:{expression:{type:'string',required:true}},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{throw Error('calculation unavailable')}}))
 f.adapter.scripts.push(call(),answer('总金额45元'),answer('总金额45元'))
 await send(f,'failed-receipt');assert.equal(completed(f),false);assert.equal(notices(f).length,1)
 const before=notices(f).length,message=createUserMessage({source:{kind:'user',rpcId:'task-run-owned'},content:[{type:'text',text:question}]})
 f.adapter.scripts.push(answer('17+28=46'))
 await f.work.withNewInput(f.agent,message,{producer:'task-run',identity:'task-run'},()=>f.agent.followup(message));await f.agent.whenIdle()
 assert.equal(notices(f).length,before);assert.equal(completed(f),true,'该producer继续交给TaskRun已有专用复核，不叠加普通会话门')
})
test('收尾前撤销原许可，算术纠正不能另获新授权或继续派发',{timeout:15000},async t=>{
 const f=await nativeHotCausalityFixture(t)
 f.ctx.on('agent/turn-stopping',()=>{f.rights.revoked=true},{global:true,prepend:true})
 f.adapter.scripts.push(answer('总金额45元'))
 await send(f,'revoke-before-verification')
 assert.equal(f.adapter.requests.length,1);assert.equal(notices(f).length,0);assert.equal(completed(f),false)
})
