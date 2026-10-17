import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import ts from 'typescript'
import {createWorkControlApi} from '../src/client/work-control-api.ts'
import {createPendingReceiptRpc} from '../src/client/pending-receipt-rpc.ts'
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.includes('/ui-workbench/src/client/i18n/')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(existsSync(source))return next(source.href,context)
 }
 return next(specifier,context)
}})
const {localizeWorkError,errorMessageKey}=await import('../src/client/i18n/errors.ts')
const {translateMessage}=await import('../src/client/i18n/messages.ts')
const locales=['zh-CN','zh-Hant','en'] as const,reasons=['tokens','rounds','concurrent','elapsed'] as const
const words={tokens:['token','token','token'],rounds:['轮次','輪次','round'],concurrent:['并发','並發','concurrent'],elapsed:['耗时','耗時','time']}
test('稳定预算错误按真实维度和范围显示简繁英，不能冒充版本过期或回显原始异常',()=>{
 assert.notEqual(errorMessageKey('teloa/budget-exhausted'),'error.unknown')
 for(const [index,locale]of locales.entries())for(const reason of reasons)for(const scope of ['work','owner']){
  const error={code:'teloa/budget-exhausted',message:'PRIVATE_SERVER_TOKEN_VALUE',details:{reason,scope}},before=structuredClone(error),text=localizeWorkError(locale,error)
  assert.ok(text.includes(words[reason][index]!),locale+'/'+reason);assert.ok(text.includes(translateMessage(locale,scope==='owner'?'planWork.budget.owner':'planWork.budget.account')),locale+'/'+scope)
  assert.ok(text.includes(translateMessage(locale,'planWork.budget.title')));assert.notEqual(text,translateMessage(locale,'error.versionConflict'));assert.doesNotMatch(text,/PRIVATE_SERVER_TOKEN_VALUE|\{scope\}/);assert.deepEqual(error,before)
 }
})
test('未知预算维度保持需要核对，不猜耗尽原因；其它未知错误和真实版本冲突保留原义',()=>{
 for(const locale of locales){
  const generic=localizeWorkError(locale,{code:'teloa/budget-exhausted'})
  assert.ok(generic.includes(translateMessage(locale,'planWork.budget.title')));assert.notEqual(generic,translateMessage(locale,'error.unknown'))
  for(const reason of ['unknown','PRIVATE_REASON',null,{},undefined])assert.equal(localizeWorkError(locale,{code:'teloa/budget-exhausted',message:'PRIVATE_RAW',details:{reason,scope:'PRIVATE_OWNER'}}),generic)
  assert.equal(localizeWorkError(locale,{code:'teloa/version-conflict',details:{reason:'tokens'}}),translateMessage(locale,'error.versionConflict'))
  assert.equal(localizeWorkError(locale,{code:'vendor/new-code',message:'预算已用尽',details:{reason:'tokens'}}),translateMessage(locale,'error.unknown'))
 }
})
test('恢复操作的正式预算拒绝保留稳定code/details，不自动重发或提高额度',async()=>{
 const control={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',generation:2,version:3,state:'paused' as const,scope:'definition' as const,pendingRunIds:[],unknownOperationIds:[]},runId='33333333-3333-4333-8333-333333333333',requestId='22222222-2222-4222-8222-222222222222'
 let raw:string|null=null,calls=0;const error=Object.assign(Error('PRIVATE_RAW'),{rejected:true,code:'teloa/budget-exhausted',details:{reason:'elapsed',scope:'owner'}}),api=createWorkControlApi(async endpoint=>{assert.equal(endpoint,'work-recovery/resume');calls++;throw error},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}},()=>requestId)
 await assert.rejects(api.resume(control,[runId]),cause=>cause===error);assert.equal(calls,1);assert.equal(raw,null);assert.equal(api.pending(),undefined);assert.match(localizeWorkError('zh-CN',error),/耗时/);assert.doesNotMatch(localizeWorkError('en',error),/PRIVATE_RAW|version/i)
})
test('实际index传输适配器保留预算code/details，用户错误只取词典且拒绝后不发ack或重做',async()=>{
 const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8'),file=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true)
 let adapter:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='workControlApi'&&node.initializer&&ts.isCallExpression(node.initializer))adapter=node.initializer.arguments[0];ts.forEachChild(node,visit)};visit(file);assert.ok(adapter,'必须执行当前真实装配回调')
 const calls:string[]=[],details={reason:'concurrent',scope:'owner'},transport=createPendingReceiptRpc(async endpoint=>{calls.push(endpoint);return {ok:false,error:{code:'teloa/budget-exhausted',message:'PRIVATE_HOST_STACK',details}}},()=>{throw Error('被拒绝的预算请求没有成功回执可ack')})
 const code=ts.transpileModule('exports.call='+adapter.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,exports:Record<string,unknown>={};new Function('callWithReceipt','exports',code)(transport,exports)
 const call=exports.call as (endpoint:string,payload:unknown)=>Promise<unknown>,control={id:'11111111-1111-4111-8111-111111111111',ownerId:'local:owner',generation:2,version:3,state:'paused' as const,scope:'definition' as const,pendingRunIds:[],unknownOperationIds:[]},api=createWorkControlApi(call)
 let failure:unknown;try{await api.resume(control,['33333333-3333-4333-8333-333333333333'])}catch(error){failure=error}
 assert.ok(failure&&typeof failure==='object'&&'code'in failure&&'details'in failure);assert.equal(failure.code,'teloa/budget-exhausted');assert.deepEqual(failure.details,details)
 for(const locale of locales){const text=localizeWorkError(locale,failure);assert.ok(text.includes(translateMessage(locale,'planWork.budget.owner')));assert.doesNotMatch(text,/PRIVATE_HOST_STACK/)}
 assert.deepEqual(calls,['work-recovery/resume']);assert.equal(api.pending(),undefined)
})
