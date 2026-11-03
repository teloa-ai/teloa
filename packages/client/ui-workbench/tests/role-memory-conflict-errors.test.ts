import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'

// 绑定当前源码；临时内存 bundle 不写 lib，也不以旧编译物验证新提示。
const result=await build({configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),logLevel:'error',build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:fileURLToPath(new URL('../src/client/i18n/errors.ts',import.meta.url)),formats:['es']}}})
const bundle=Array.isArray(result)?result[0]!:result
assert.ok('output' in bundle)
const output=bundle.output.find(item=>item.type==='chunk')
assert.ok(output&&output.type==='chunk')
const {localizeWorkError}=await import('data:text/javascript;base64,'+Buffer.from(output.code).toString('base64')) as {localizeWorkError:(locale:string,error:unknown)=>string}

test('记忆同槽重复/冲突给出三语原员工记忆解决路径，不泛化重试或泄露正文',()=>{
 for(const kind of ['duplicate','content']){
  const error={code:'teloa/conflict',details:{reason:'role-memory-slot-conflict',kind,roleId:'internal-role'},message:'秘密正文与内部堆栈'}
  for(const [locale,expected] of [['zh-CN',/员工记忆.*编辑或撤回.*重试/],['zh-Hant',/員工記憶.*編輯或撤回.*重試/],['en',/employee.*memor.*edit or withdraw.*try again/i]] as const){
   const before=structuredClone(error),text=localizeWorkError(locale,error);assert.match(text,expected);assert.doesNotMatch(text,/稍后|稍後|later|秘密|internal-role|堆栈/);assert.deepEqual(error,before)
  }
 }
})

test('只有稳定冲突reason使用专用提示，区域繁体和其他语言沿现有回退',()=>{
 const error={code:'teloa/conflict',details:{reason:'role-memory-slot-conflict'}}
 assert.equal(localizeWorkError('zh-TW',error),localizeWorkError('zh-Hant',error));assert.equal(localizeWorkError('zh-HK',error),localizeWorkError('zh-Hant',error))
 assert.equal(localizeWorkError('ja',error),localizeWorkError('en',error))
 assert.notEqual(localizeWorkError('zh-CN',error),localizeWorkError('zh-CN',{...error,details:{reason:'unknown'}}))
 assert.notEqual(localizeWorkError('zh-CN',error),localizeWorkError('zh-CN',{...error,code:'teloa/version-conflict'}))
})

test('跨来源适用主题冲突提示不再误称仅同来源',()=>{
 const error={code:'teloa/conflict',details:{reason:'role-memory-slot-conflict',kind:'duplicate'}}
 for(const [locale,topic,source]of [['zh-CN',/同适用主题/,/同来源/],['zh-Hant',/同適用主題/,/同來源/],['en',/applicable topic/i,/same source/i]]as const){const text=localizeWorkError(locale,error);assert.match(text,topic);assert.doesNotMatch(text,source)}
})
