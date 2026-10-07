import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

// .tsx 走 tsc 产物，CSS Modules 换成类名代理（同 attention-decision-card.test.ts）。
registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})
const {RoleToolGrantOptions}=await import('../lib/types/client/RoleToolGrants.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const skillHttp=[{skill:'x-search',origins:['https://api.x.ai'],configured:true,source:'role' as const},{skill:'mx-finance-search',origins:['https://api.example.com'],configured:false,source:'industry' as const}]
const webAndSkillHttp={roleVersion:3,rules:[{name:'web_search',allowed:[],anyArguments:true},{name:'teloa_skill_http',allowed:[{skill:'x-search'},{skill:'mx-finance-search'}]}],skillHttp}
const render=(candidates:unknown,locale='en')=>renderToStaticMarkup(createElement(RoleToolGrantOptions as never,{candidates,names:{},selected:[],toggle:()=>{},disabled:false,locale,t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale as never,key as never,params)}))
const labels=(html:string)=>[...html.matchAll(/<label[^>]*>.*?<\/label>/g)].map(match=>match[0])

test('文件授权使用可理解的当前工作目录名称和真实勾选框，范围说明不隐去',()=>{
 const html=render({roleVersion:3,rules:['read','write','edit'].map(name=>({name,allowed:[],workspaceFiles:'default-workspace'}))},'zh-CN')
 for(const [name,label] of [['read','读取当前工作目录'],['write','写入当前工作目录'],['edit','编辑当前工作目录']])assert.match(html,new RegExp('data-teloa-file-grant="'+name+'"[^>]*>.*?type="checkbox".*?<span>'+label+'</span>'))
 assert.match(html,/应用数据、Git 设置和账号密钥等敏感信息不包含在内/)
})

test('技能接口代发候选逐项成行：每项一个带分隔样式的 label，名称与来源、密钥状态分开，英文不连成一串',()=>{
 const html=render(webAndSkillHttp)
 const rows=labels(html)
 assert.ok(rows.length>=3,html)
 for(const row of rows)assert.match(row,/^<label class="grantOption">/,row)
 const skillRows=rows.filter(row=>row.includes('x-search')||row.includes('mx-finance-search'))
 assert.equal(skillRows.length,2)
 assert.match(skillRows[0]!,/<span>x-search \(calls https:\/\/api\.x\.ai\)<\/span><small>[^<]+<\/small><small>[^<]+<\/small><\/label>$/)
 assert.ok(!/<small> /.test(html),'small 不再靠前导空格与前文隔开')
})

test('只有上网与技能接口代发候选时，「可授予权限」栏写明候选在下方，不留空框',()=>{
 const en=render(webAndSkillHttp)
 const box=en.slice(0,en.indexOf('</fieldset>'))
 assert.ok(box.includes(translateMessage('en','subagent.grant.options')))
 assert.ok(box.includes(translateMessage('en','roleGrant.otherCandidates',{groups:translateMessage('en','roleGrant.web.title')+', '+translateMessage('en','roleGrant.skillHttp.title')})),box)
 assert.ok(!box.includes(translateMessage('en','roleGrant.noKnowledge')))
 const zh=render(webAndSkillHttp,'zh-CN')
 assert.ok(zh.includes('网页搜索与读取、技能接口代发'),zh)
 // 只剩代发时只列代发一栏
 const onlySkillHttp=render({roleVersion:3,rules:[webAndSkillHttp.rules[1]],skillHttp},'zh-CN')
 assert.ok(onlySkillHttp.includes(translateMessage('zh-CN','roleGrant.otherCandidates',{groups:'技能接口代发'})))
})

test('什么候选都没有时仍提示没有可授权的资料；本栏有自己的候选时不出提示',()=>{
 assert.ok(render({roleVersion:3,rules:[]}).includes(translateMessage('en','roleGrant.noKnowledge')))
 const own=render({roleVersion:3,rules:[{name:'mcp__docs__read',allowed:[{id:'r1',version:'abcdef0123456789'}]},...webAndSkillHttp.rules],skillHttp})
 const box=own.slice(0,own.indexOf('</fieldset>'))
 assert.ok(!box.includes(translateMessage('en','roleGrant.noKnowledge'))&&!box.includes('see the sections below'),box)
 assert.match(box,/<label class="grantOption">/)
})
