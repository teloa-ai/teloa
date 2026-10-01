import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {mount} from './market-component-harness.ts'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {SkillSecretsViewPresentation}=await import('../lib/types/client/SkillSecretsView.js')
const {createSkillSecretsApi,skillSecretsBadge}=await import('../lib/types/client/skill-secrets-api.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const t=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params as never)
const xaiVar={envVarName:'XAI_API_KEY',label:{'zh-CN':'xAI API 密钥',en:'xAI API key'},required:true,configured:true,target:'bearer' as const,endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}]}
const state={skill:'x-search',binding:'a'.repeat(64),writable:true,reconfirm:false,vars:[xaiVar]}
const render=(props:Record<string,unknown>)=>renderToStaticMarkup(createElement(SkillSecretsViewPresentation as never,{title:'X 搜索',state,busy:false,error:'',locale:'zh-CN',t,confirmingDelete:false,onBack:()=>{},onSave:()=>{},onAskDelete:()=>{},onCancelDelete:()=>{},onDelete:()=>{},...props} as never))

test('密码框 write-only，只显示已保存状态，不含值与禁词',()=>{
 const html=render({})
 assert.match(html,/type="password"/);assert.match(html,/autocomplete="new-password"/i)
 assert.doesNotMatch(html,/value="/);assert.match(html,/已保存/);assert.doesNotMatch(html,/人类|实例|工作空间|投影/)
})
test('声明变化显示需重新确认；只读存储禁用保存并提示',()=>{
 assert.match(render({state:{...state,reconfirm:true}}),/重新确认/)
 const html=render({state:{...state,writable:false}});assert.match(html,/disabled/);assert.match(html,/只读/)
})
test('已添加卡片徽标：已保存 / 未填写 / 需重新确认',()=>{
 assert.match(skillSecretsBadge(state,t),/已保存/)
 assert.match(skillSecretsBadge({...state,vars:[{...state.vars[0]!,configured:false}]},t),/未填写/)
 assert.match(skillSecretsBadge({...state,reconfirm:true},t),/重新确认/)
})
test('api 白名单：载荷与回包校验，回包多字段拒绝',async()=>{
 const calls:unknown[]=[]
 const api=createSkillSecretsApi(async(method:string,payload:unknown)=>{calls.push([method,payload]);return state})
 const value='xai'+'-'+'0123456789abcdefghij'
 await api.describe('x-search');await api.save('x-search',{XAI_API_KEY:value},state.binding);await api.remove('x-search')
 assert.deepEqual(calls,[['skill-secrets/describe',{skill:'x-search'}],['skill-secrets/save',{skill:'x-search',values:{XAI_API_KEY:value},expectedBinding:state.binding}],['skill-secrets/delete',{skill:'x-search'}]])
 await assert.rejects(createSkillSecretsApi(async()=>({...state,value:'leak'})).describe('x-search'),/格式不正确/)
 await assert.rejects(api.save('x-search',{bad_name:'x'},state.binding),/变量名/)
})

// 审查 P-1：回包每个变量带声明目标（origin + 路径前缀）与注入位置；键名仍严格。
test('readState 接受 target/name/endpoints 并按注入位置严格校验',async()=>{
 const reply=(vars:unknown[])=>createSkillSecretsApi(async()=>({...state,vars})).describe('x-search')
 const header={...xaiVar,envVarName:'MX_KEY',target:'header',name:'X-Api-Key',endpoints:[{origin:'https://mx.example.com',pathPrefixes:['/a/','/b']}]}
 assert.deepEqual((await reply([xaiVar,header])).vars,[xaiVar,header])
 await assert.rejects(reply([{...xaiVar,name:'X'}]),/格式不正确/,'bearer 不得带 name')
 for(const name of ['',null,0,{},undefined])await assert.rejects(reply([{...xaiVar,name}]),/格式不正确/,'bearer 不得带任何形态的 name 字段')
 await assert.rejects(reply([{...header,name:undefined}]),/格式不正确/,'header 必须带 name')
 await assert.rejects(reply([{...xaiVar,target:'cookie'}]),/格式不正确/)
 await assert.rejects(reply([{...xaiVar,endpoints:[{origin:'http://api.x.ai',pathPrefixes:['/']}]}]),/格式不正确/,'只收 https')
 await assert.rejects(reply([{...xaiVar,endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/'],extra:1}]}]),/格式不正确/)
 await assert.rejects(reply([{...xaiVar,endpoints:[{origin:'https://api.x.ai',pathPrefixes:[1]}]}]),/格式不正确/)
 const {endpoints:_,...noEndpoints}=xaiVar
 await assert.rejects(reply([noEndpoints]),/格式不正确/)
 await assert.rejects(reply([{...xaiVar,value:'leak'}]),/格式不正确/,'变量上多出值字段即拒')
})

test('声明指纹严格回包：有声明须为 SHA256，无声明须为 null，保存不得漏传',async()=>{
 const describe=(patch:Record<string,unknown>)=>createSkillSecretsApi(async()=>({...state,...patch})).describe('x-search')
 for(const binding of [undefined,null,'','x'.repeat(64),1])await assert.rejects(describe({binding}),/格式不正确/)
 await assert.rejects(describe({vars:[]}),/格式不正确/)
 assert.equal((await describe({vars:[],binding:null})).binding,null)
 let calls=0
 const api=createSkillSecretsApi(async()=>{calls++;return state})
 await assert.rejects(api.save('x-search',{XAI_API_KEY:'not-a-real-key'},undefined as never),/校验值/)
 assert.equal(calls,0)
})

test('过期页面只刷新目标并提示，绝不重试旧值；下一次用户提交采用新指纹',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[],next={...state,binding:'b'.repeat(64),vars:[{...xaiVar,endpoints:[{origin:'https://new.example.com',pathPrefixes:['/v2/']}]}]}
 let version=0,failRefresh=false
 const api=createSkillSecretsApi(async(endpoint,payload)=>{
  calls.push({endpoint,payload})
  if(endpoint==='skill-secrets/describe'){if(failRefresh)throw Error('offline');return version?next:state}
  if(version===1){version++;throw Object.assign(Error('changed'),{code:'teloa/version-conflict'})}
  return next
 })
 const fixture=mount('SkillSecretsView.tsx',{'./i18n/provider.js':{useI18n:()=>({t,locale:'zh-CN'})}})
 const props={skill:'x-search',title:'测试技能',api,onBack(){}}
 const renderView=()=>fixture.render('SkillSecretsView',props)
 renderView();fixture.effects[0]!();await new Promise<void>(resolve=>setImmediate(resolve))
 assert.equal(renderView().props.state.binding,state.binding)
 version=1;renderView().props.onSave({XAI_API_KEY:'fake-first-value'})
 await new Promise<void>(resolve=>setImmediate(resolve))
 const refreshed=renderView()
 assert.equal(refreshed.props.state.binding,next.binding);assert.match(refreshed.props.error,/重新确认/)
 assert.match(render(refreshed.props),/https:\/\/new\.example\.com\/v2\//)
 assert.doesNotMatch(render(refreshed.props),/fake-first-value/)
 assert.deepEqual(calls.map(call=>call.endpoint),['skill-secrets/describe','skill-secrets/save','skill-secrets/describe'])
 refreshed.props.onSave({XAI_API_KEY:'fake-second-value'});await new Promise<void>(resolve=>setImmediate(resolve))
 assert.deepEqual(calls.at(-1)!.payload,{skill:'x-search',values:{XAI_API_KEY:'fake-second-value'},expectedBinding:next.binding})
 assert.equal(renderView().props.error,'')
 // 刷新失败必须收起旧表单，不能保留旧目标继续保存。
 version=1;failRefresh=true;renderView().props.onSave({XAI_API_KEY:'fake-third-value'});await new Promise<void>(resolve=>setImmediate(resolve))
 assert.equal(renderView().props.state,null);assert.match(renderView().props.error,/操作未完成/)
})
test('页面如实显示此密钥将发往何处与注入位置',()=>{
 const html=render({state:{...state,vars:[xaiVar,{...xaiVar,envVarName:'MX_KEY',target:'query',name:'apikey',endpoints:[{origin:'https://mx.example.com',pathPrefixes:['/api/']}]}]}})
 assert.match(html,/将发往/);assert.match(html,/https:\/\/api\.x\.ai\/v1\//);assert.match(html,/Authorization/)
 assert.match(html,/https:\/\/mx\.example\.com\/api\//);assert.match(html,/查询参数 apikey/)
})
test('未安装（当前生效的不是声明密钥的市场安装）显示需先安装，不给表单',()=>{
 const html=render({state:{...state,vars:[]}})
 assert.match(html,/需先安装/);assert.doesNotMatch(html,/type="password"/);assert.doesNotMatch(html,/<form/)
 assert.match(skillSecretsBadge({...state,vars:[]},t),/需先安装/)
})
test('存储锁定或只读：不显示未填写/已保存，给出到设置页处理的引导，不给删除',()=>{
 const locked={...state,writable:false,vars:[{...xaiVar,configured:false}]}
 const html=render({state:locked})
 assert.doesNotMatch(html,/未填写|已保存/);assert.match(html,/设置 &gt; 密钥存储/);assert.doesNotMatch(html,/删除密钥/)
 assert.match(skillSecretsBadge(locked,t),/锁定/);assert.doesNotMatch(skillSecretsBadge(locked,t),/未填写/)
})
test('需重新确认时提示其余变量会被清除',()=>{
 assert.match(render({state:{...state,reconfirm:true}}),/其余密钥会被清除/)
})
test('删除需确认：先点删除只出确认框，确认框内才有确认删除',()=>{
 assert.match(render({}),/删除密钥/);assert.doesNotMatch(render({}),/确认删除/)
 const html=render({confirmingDelete:true});assert.match(html,/确定删除该技能已保存的全部密钥/);assert.match(html,/确认删除/);assert.match(html,/取消/)
})

// 规格 2026-09-27 §4.5：共享密钥组——共用说明列出成员；删除确认列出受影响技能；无 group 时渲染不变。
test('共享密钥组：显示共用说明与成员，删除确认列出受影响技能；无 group 时渲染与现状相同',()=>{
 const shared={...state,group:{id:'maton-gateway',members:['google-mail','slack-api','x-search']}}
 const html=render({state:shared})
 assert.match(html,/同组技能共用/);assert.match(html,/google-mail/);assert.match(html,/slack-api/)
 assert.doesNotMatch(html,/人类|实例|工作空间|投影/)
 const confirm=render({state:shared,confirmingDelete:true})
 assert.match(confirm,/确定删除这组共用密钥/);assert.match(confirm,/google-mail/);assert.doesNotMatch(confirm,/确定删除该技能已保存的全部密钥/)
 assert.equal(render({}),render({state:{...state}}))
 assert.doesNotMatch(render({}),/同组技能共用/)
 assert.match(render({confirmingDelete:true}),/确定删除该技能已保存的全部密钥/)
})
test('api 回包 group 严格校验：id 与成员名格式、成员须含本技能、未安装态不得带 group',async()=>{
 const reply=(patch:Record<string,unknown>)=>createSkillSecretsApi(async()=>({...state,...patch})).describe('x-search')
 assert.deepEqual((await reply({group:{id:'maton-gateway',members:['slack-api','x-search']}})).group,{id:'maton-gateway',members:['slack-api','x-search']})
 assert.equal('group' in (await reply({})),false)
 for(const group of [null,{id:'Bad',members:['x-search']},{id:'maton-gateway',members:[]},{id:'maton-gateway',members:['slack-api']},{id:'maton-gateway',members:['x-search','../x']},{id:'maton-gateway',members:['x-search'],extra:1},{id:'maton-gateway'}])await assert.rejects(reply({group}),/格式不正确/,JSON.stringify(group))
 await assert.rejects(reply({vars:[],binding:null,group:{id:'maton-gateway',members:['x-search']}}),/格式不正确/)
})
test('共享密钥组新词条：十套主语言齐全、无禁词',()=>{
 const forbidden:Record<string,RegExp>={'zh-CN':/工作空间|单空间|实例|投影|人类/,'zh-Hant':/工作空間|單空間|實例|投影|人類/,en:/workspace|instance|\bhumans?\b/i,ja:/ワークスペース|インスタンス|人間/,ko:/워크스페이스|인스턴스|인간/,vi:/workspace|instance|con người/i,es:/workspace|instance|humanos?/i,fr:/workspace|instance|humains?/i,de:/workspace|instance|Mensch(?:en)?/i,pt:/workspace|instance|humanos?/i}
 for(const key of ['market.skillSecrets.sharedGroup','market.skillSecrets.deleteConfirmShared'])for(const locale of Object.keys(forbidden)){
  const value=translateMessage(locale as never,key as never,{skills:'a、b'} as never)
  assert.ok(value&&!value.startsWith('market.')&&!/\{\w+\}/.test(value)&&value.includes('a、b'),`${locale} ${key}`)
  assert.doesNotMatch(value,forbidden[locale]!,`${locale} ${key}`)
 }
})
