import test from 'node:test'
import assert from 'node:assert/strict'
import {
 webAccessKinds,webAccessEntryMaxChars,webAccessBlockedMax,
 isWebAccessBlockedHost,webHostBlocked,webAccessHost,isWebAccessPolicy,
 readWebAccessEntry,webAccessPolicyChangeInput,
 type WebAccessPolicy,
} from '../src/web-access.ts'

const requestId='16057272-ed9d-44a3-abe4-2ab04e056105'

test('webAccessKinds 恰好两值',()=>{
 assert.deepEqual(webAccessKinds,['search','fetch'])
})

function basePolicy(overrides:Partial<WebAccessPolicy>={}):WebAccessPolicy{
 return {version:1,enabled:true,blocked:['x.com'],...overrides}
}

test('isWebAccessPolicy 多一个键即 false（精确三键）',()=>{
 assert.equal(isWebAccessPolicy(basePolicy()),true)
 assert.equal(isWebAccessPolicy({...basePolicy(),extra:'x'}),false)
})

test('isWebAccessPolicy 对 version/enabled/blocked 类型各一条异常',()=>{
 assert.equal(isWebAccessPolicy(basePolicy({version:-1})),false)
 assert.equal(isWebAccessPolicy({...basePolicy(),enabled:'true'}),false)
 assert.equal(isWebAccessPolicy({...basePolicy(),blocked:'x.com'}),false)
})

test('isWebAccessBlockedHost 八类非法输入逐条为 false',()=>{
 assert.equal(isWebAccessBlockedHost('x.com'),true)
 assert.equal(isWebAccessPolicy(basePolicy({blocked:Array.from({length:129},(_,i)=>`h${i}.com`)})),false)
 assert.equal(isWebAccessPolicy(basePolicy({blocked:['x.com','x.com']})),false)
 assert.equal(isWebAccessBlockedHost(''),false)
 assert.equal(isWebAccessBlockedHost('a'.repeat(254)),false)
 assert.equal(isWebAccessBlockedHost('X.com'),false)
 assert.equal(isWebAccessBlockedHost('x_com'),false)
 assert.equal(isWebAccessBlockedHost('.x.com'),false)
 assert.equal(isWebAccessBlockedHost('x..com'),false)
 assert.equal(isWebAccessBlockedHost('http://x'),false)
 assert.equal(isWebAccessBlockedHost('x.com/path'),false)
 assert.equal(isWebAccessBlockedHost('x.com:8080'),false)
 assert.equal(isWebAccessBlockedHost('*.x.com'),false)
 assert.equal(isWebAccessBlockedHost('10.0.0.1'),false)
})

test('webHostBlocked 表驱动',()=>{
 const blocked=['example.com']
 assert.equal(webHostBlocked(blocked,'example.com'),true)
 assert.equal(webHostBlocked(blocked,'a.example.com'),true)
 assert.equal(webHostBlocked(blocked,'a.b.example.com'),true)
 assert.equal(webHostBlocked(blocked,'notexample.com'),false)
 assert.equal(webHostBlocked(blocked,'example.com.evil.net'),false)
 assert.equal(webHostBlocked(blocked,'exampleXcom'),false)
 assert.equal(webHostBlocked([],'example.com'),false)
 // 大小写不敏感：判据只对传入的 host 做归一化；blocked 里的规则本身已由 isWebAccessBlockedHost 钉死为小写。
 assert.equal(webHostBlocked(blocked,'EXAMPLE.COM'),true)
 assert.equal(webHostBlocked(blocked,'A.EXAMPLE.COM'),true)
})

test('webAccessHost 归一化与拒绝分支',()=>{
 assert.equal(webAccessHost('https://A.Example.COM/x'),'a.example.com')
 assert.equal(webAccessHost('https://example.com./'),'example.com')
 assert.equal(webAccessHost('ftp://x'),null)
 assert.equal(webAccessHost('javascript:alert(1)'),null)
 assert.equal(webAccessHost('https://u:p@x.com'),null)
 assert.equal(webAccessHost('不是URL'),null)
 assert.equal(webAccessHost('h'.repeat(2049)),null)
 assert.equal(webAccessHost('https://中文.example.com/'),'xn--fiq228c.example.com')
})

const validEntry={kind:'search' as const,value:'今天天气',at:'2026-09-21T09:00:00.000Z'}

test('readWebAccessEntry：kind 只认两个值，第三个值抛',()=>{
 assert.deepEqual(readWebAccessEntry(validEntry),validEntry)
 assert.deepEqual(readWebAccessEntry({...validEntry,kind:'fetch'}),{...validEntry,kind:'fetch'})
 assert.throws(()=>readWebAccessEntry({...validEntry,kind:'browse'}),{code:'teloa/invalid-input'})
})

test('readWebAccessEntry：value 超过上限抛',()=>{
 assert.equal(webAccessEntryMaxChars,512)
 assert.deepEqual(readWebAccessEntry({...validEntry,value:'a'.repeat(512)}),{...validEntry,value:'a'.repeat(512)})
 assert.throws(()=>readWebAccessEntry({...validEntry,value:'a'.repeat(513)}),{code:'teloa/invalid-input'})
})

test('readWebAccessEntry：at 非 ISO（不可解析）抛',()=>{
 assert.throws(()=>readWebAccessEntry({...validEntry,at:'不是时间'}),{code:'teloa/invalid-input'})
})

test('readWebAccessEntry：未知键与缺键均抛',()=>{
 assert.throws(()=>readWebAccessEntry({...validEntry,extra:'x'}),{code:'teloa/invalid-input'})
 const {at,...missingAt}=validEntry
 assert.throws(()=>readWebAccessEntry(missingAt),{code:'teloa/invalid-input'})
})

const validChange={requestId,expectedVersion:1,enabled:true,blocked:['x.com']}

test('webAccessPolicyChangeInput：白名单恰好四键，未知键即抛',()=>{
 assert.deepEqual(webAccessPolicyChangeInput(validChange),validChange)
 assert.throws(()=>webAccessPolicyChangeInput({...validChange,extra:'x'}),{code:'teloa/invalid-input'})
})

test('webAccessPolicyChangeInput：缺键即抛',()=>{
 const {blocked,...missingBlocked}=validChange
 assert.throws(()=>webAccessPolicyChangeInput(missingBlocked),{code:'teloa/invalid-input'})
 const {requestId:_rid,...missingRequestId}=validChange
 assert.throws(()=>webAccessPolicyChangeInput(missingRequestId),{code:'teloa/invalid-input'})
})

test('webAccessBlockedMax 为 128',()=>{
 assert.equal(webAccessBlockedMax,128)
})
