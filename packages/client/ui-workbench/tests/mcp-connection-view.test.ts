import './fixtures/brand-asset-hooks.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {registerHooks} from 'node:module'
import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'

registerHooks({
 resolve:(specifier,context,next)=>specifier.endsWith('.module.css')?{url:new URL(specifier,context.parentURL).href,shortCircuit:true}:next(specifier,context),
 load:(url,context,next)=>url.endsWith('.module.css')?{format:'module',shortCircuit:true,source:'export default new Proxy({},{get:(_,key)=>String(key)})'}:next(url,context),
})

const {McpConnectionViewPresentation}=await import('../lib/types/client/McpConnectionView.js')
const {translateMessage}=await import('../lib/types/client/i18n/messages.js')

const noop=()=>{}
const t=(key:string,params?:Record<string,string|number>)=>translateMessage('zh-CN',key as never,params)
const base={title:'DeepWiki（官方远程）',busy:false,locale:'zh-CN',t,onBack:noop,onConnect:noop,onDisconnect:noop,onDelete:noop,onDeleteConfirm:noop}
const render=(props:Record<string,unknown>)=>renderToStaticMarkup(createElement(McpConnectionViewPresentation as never,{...base,...props} as never))

test('no-auth：无凭据输入，显示测试连接按钮',()=>{
 const html=render({phase:{phase:'no-auth',error:''}})
 assert.match(html,/测试连接/)
 assert.doesNotMatch(html,/<input/)
 assert.doesNotMatch(html,/type="password"/)
 assert.doesNotMatch(html,/人类|实例|工作空间|投影/)
 assert.match(html,/返回/)
})

test('secret-empty：每个凭据变量一个 password 输入，write-only',()=>{
 const vars=[
  {target:'env',envVarName:'GITHUB_TOKEN',label:{'zh-CN':'GitHub 令牌','en':'GitHub token'},required:true},
  {target:'bearer',label:{'zh-CN':'Bearer 令牌','en':'Bearer token'},required:false},
 ]
 const html=render({phase:{phase:'secret-empty',vars,serverName:'github',error:''}})
 assert.match(html,/测试连接/)
 // 两个 password 输入
 const inputs=[...html.matchAll(/type="password"/g)]
 assert.equal(inputs.length,2)
 // autoComplete="new-password"（write-only）
 assert.match(html,/autoComplete="new-password"/)
 // 不预填值
 assert.doesNotMatch(html,/value="/)
 // 有 required 属性
 assert.match(html,/required/)
 assert.doesNotMatch(html,/人类|实例|工作空间|投影/)
})

test('connected：显示已连接状态和工具列表，只读/可写标注',()=>{
 const record={id:'11111111-1111-4111-8111-111111111111',catalogId:'teloa.mcp-deepwiki',serverName:'deepwiki',status:'connected',createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z',tools:[{name:'ask_question',fullName:'deepwiki.ask_question',readOnly:true},{name:'write_wiki',fullName:'deepwiki.write_wiki',readOnly:false}]}
 const html=render({phase:{phase:'connected',record,deleteConfirm:false}})
 assert.match(html,/已连接/)
 assert.match(html,/ask_question/)
 assert.match(html,/write_wiki/)
 assert.match(html,/只读/)
 assert.match(html,/可写/)
 assert.match(html,/断开/)
 assert.match(html,/删除/)
 assert.doesNotMatch(html,/<input/)
 assert.doesNotMatch(html,/确认删除/)
 assert.doesNotMatch(html,/人类|实例|工作空间|投影/)
})

test('connected：deleteConfirm=true 时显示确认框',()=>{
 const record={id:'11111111-1111-4111-8111-111111111111',catalogId:'teloa.mcp-deepwiki',serverName:'deepwiki',status:'connected',createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z',tools:[]}
 const html=render({phase:{phase:'connected',record,deleteConfirm:true}})
 assert.match(html,/确认删除/)
 assert.match(html,/确认删除<\/button>|确认删除</)
 assert.match(html,/取消/)
})

test('error：显示错误状态和错误信息，可重试',()=>{
 const record={id:'11111111-1111-4111-8111-111111111111',catalogId:'teloa.mcp-github',serverName:'github',status:'error',errorMessage:'连接超时',createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z'}
 const html=render({phase:{phase:'error',record,deleteConfirm:false}})
 assert.match(html,/连接出错/)
 assert.match(html,/连接超时/)
 assert.match(html,/测试连接/)
 assert.match(html,/删除/)
 assert.doesNotMatch(html,/<input/)
 assert.doesNotMatch(html,/人类|实例|工作空间|投影/)
})

test('unsupported：显示原因说明，无凭据输入，无连接按钮',()=>{
 const reason='Composio 远程端点实测时重定向至无效页面（HTTP 404）'
 const html=render({phase:{phase:'unsupported',reason}})
 assert.match(html,/HTTP 404/)
 assert.doesNotMatch(html,/<input/)
 assert.doesNotMatch(html,/测试连接/)
 assert.doesNotMatch(html,/人类|实例|工作空间|投影/)
 assert.match(html,/返回/)
})

test('busy=true 时所有操作按钮禁用',()=>{
 const record={id:'11111111-1111-4111-8111-111111111111',catalogId:'teloa.mcp-deepwiki',serverName:'deepwiki',status:'connected',createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z',tools:[]}
 const html=render({phase:{phase:'connected',record,deleteConfirm:false},busy:true})
 // 所有按钮均有 disabled
 assert.match(html,/disabled=""/)
})

const view=await import('../lib/types/client/McpConnectionView.js')
test('迁移推荐只取当前目录中的推荐官方连接器，真实 connected 记录才标就绪',async()=>{
 const {connectorEntry,connectionRecord}=await import('./market-navigation-fixture.ts')
 const old=connectorEntry('teloa.legacy'),target=connectorEntry()
 old.alternatives=[{entryId:target.id,marketplace:'teloa',installs:null,recommended:true}]
 const item=(entry:unknown)=>({entry,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}) as never
 const records=[connectionRecord(old.id)]
 const migration=(items=[item(old),item(target)],connections=records)=>view.recommendedMcpMigration(old.id,items,connections)
 assert.equal(migration()?.entry.id,target.id)
 assert.equal(migration()?.connected,false)
 for(const status of ['saved','installing','error','pending-oauth'] as const)assert.equal(migration(undefined,[...records,connectionRecord(target.id,status)])?.connected,false)
 assert.equal(migration(undefined,[...records,connectionRecord(target.id)])?.connected,true)
 assert.equal(migration(undefined,[]),undefined)
 assert.equal(migration([item(old)]),undefined)
 assert.equal(migration([item(old),item({...target,compatibility:{...target.compatibility,status:'unsupported'}})]),undefined)
 assert.equal(migration([item(old),item({...target,connector:{...target.connector,auth:{kind:'oauth',supported:true,requiresAllowlist:true,scopes:[]}}})]),undefined)
 assert.equal(migration([item({...old,alternatives:old.alternatives.map(({recommended,...rest})=>rest)}),item(target)]),undefined)
 // 官方按目录元数据判断（Teloa 目录收录的连接器），不看 teloa. 前缀
 const renamed={...target,id:'acme.remote'},aliased={...old,alternatives:[{entryId:renamed.id,marketplace:'teloa' as const,installs:null,recommended:true as const}]}
 assert.equal(view.recommendedMcpMigration(old.id,[item(aliased),item(renamed)],records)?.entry.id,'acme.remote')
})

test('迁移提示的目录读取按宿主接口缓存：再次进入不重读整份目录；失败不缓存，重试会重新读取',async()=>{
 let calls=0,fail=true
 const api={list:async()=>{calls++;if(fail)throw Error('teloa/source-unavailable');return {catalogVersion:'2026.9.27',items:[],nextCursor:null,counts:{skill:0,solution:0,role:0,connector:0,model:0},skipped:{unknownKind:0,newerApp:0}}}}
 await assert.rejects(view.loadConnectionCatalogItems(api as never))
 fail=false
 assert.deepEqual(await view.loadConnectionCatalogItems(api as never),[])
 assert.deepEqual(await view.loadConnectionCatalogItems(api as never),[])
 assert.equal(calls,2,'失败一次、成功一次，之后命中缓存')
 assert.deepEqual(await view.loadConnectionCatalogItems(api as never,{refresh:true}),[])
 assert.equal(calls,3,'重试按钮强制重读')
 const other={list:api.list}
 await view.loadConnectionCatalogItems(other as never);assert.equal(calls,4,'不同宿主接口各自缓存')
})
const oauthRecord=(status:string,extra:Record<string,unknown>={})=>({id:'11111111-1111-4111-8111-111111111111',catalogId:'teloa.mcp-slack',serverName:'slack',status,createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z',...extra})
const forbidden=/人类|实例|工作空间|投影/

test('OAuth 新连接：requiresUserClientId 时只出现一个 client_id 文本框，按钮为「去授权」',()=>{
 const html=render({phase:{phase:'oauth-new',clientId:true,error:''}})
 assert.equal([...html.matchAll(/<input/g)].length,1)
 assert.match(html,/name="oauth_client_id"/)
 assert.doesNotMatch(html,/type="password"/)
 assert.match(html,/去授权/)
 assert.doesNotMatch(html,/测试连接/)
 assert.doesNotMatch(html,forbidden)
 const plain=render({phase:{phase:'oauth-new',clientId:false,error:''}})
 assert.doesNotMatch(plain,/<input/)
 assert.match(plain,/去授权/)
})

test('OAuth 待授权：无链接时显示「等待 OAuth 授权」与「去授权」；有链接时只展示新窗口外链，不自动跳转',()=>{
 const pending=render({phase:{phase:'pending-oauth',record:oauthRecord('pending-oauth'),authorizationUrl:'',error:'',deleteConfirm:false}})
 assert.match(pending,/等待 OAuth 授权/)
 assert.match(pending,/去授权/)
 assert.match(pending,/删除/)
 assert.doesNotMatch(pending,/<a /)
 const url='https://slack.com/oauth/v2_user/authorize?client_id=123.456&state=abc&code_challenge=x'
 const linked=render({phase:{phase:'pending-oauth',record:oauthRecord('pending-oauth'),authorizationUrl:url,error:'',deleteConfirm:false}})
 const anchor=linked.match(/<a [^>]*>[^<]*<\/a>/)?.[0]??''
 assert.match(anchor,/href="https:\/\/slack\.com\/oauth\/v2_user\/authorize\?client_id=123\.456&amp;state=abc&amp;code_challenge=x"/)
 assert.match(anchor,/target="_blank"/)
 assert.match(anchor,/rel="noopener noreferrer"/)
 assert.match(anchor,/在浏览器中完成授权/)
 assert.doesNotMatch(linked,/token/i)
 assert.doesNotMatch(linked,forbidden)
 // 本地宿主授权入口可渲染
 const local='http://127.0.0.1:3100/oauth/start?state='+'b'.repeat(32)
 assert.match(render({phase:{phase:'pending-oauth',record:oauthRecord('pending-oauth'),authorizationUrl:local,error:'',deleteConfirm:false}}),/<a [^>]*href="http:\/\/127\.0\.0\.1:3100\/oauth\/start\?state=b{32}"/)
 // 非 https 链接（本地宿主授权入口除外）一律不渲染
 for(const bad of ['http://evil.example/authorize','javascript:alert(1)','http://localhost:3100/oauth/start?state='+'b'.repeat(32)]){
  const html=render({phase:{phase:'pending-oauth',record:oauthRecord('pending-oauth'),authorizationUrl:bad,error:'',deleteConfirm:false}})
  assert.doesNotMatch(html,/<a /,bad)
 }
})

test('OAuth 已连接：显示断开 / 删除，并提示断开会同时吊销授权；非 OAuth 连接不提示',()=>{
 const html=render({phase:{phase:'connected',record:oauthRecord('connected',{tools:[]}),deleteConfirm:false,oauth:true}})
 assert.match(html,/断开/)
 assert.match(html,/删除/)
 assert.match(html,/会同时吊销授权/)
 const plain=render({phase:{phase:'connected',record:oauthRecord('connected',{tools:[]}),deleteConfirm:false}})
 assert.doesNotMatch(plain,/吊销/)
})

test('OAuth 出错：只显示附录固定文案，未知宿主文本不透出；按钮为「重新授权」',()=>{
 const expired=render({phase:{phase:'error',record:oauthRecord('error',{errorMessage:'授权已过期或被吊销，请重新连接并完成 OAuth 授权。'}),deleteConfirm:false,oauth:true}})
 assert.match(expired,/授权已过期或被吊销，请重新连接并完成 OAuth 授权。/)
 assert.match(expired,/重新授权/)
 assert.doesNotMatch(expired,/测试连接/)
 const unknown=render({phase:{phase:'error',record:oauthRecord('error',{errorMessage:'upstream said: invalid_grant token=abc'}),deleteConfirm:false,oauth:true}})
 assert.doesNotMatch(unknown,/invalid_grant|token=abc/)
 assert.match(unknown,/操作未完成，请稍后重试。/)
})

test('OAuth 错误映射：附录六条固定文案逐条命中，其余走固定兜底',()=>{
 const tt=(key:string)=>t(key)
 const cases:Array<[string,string]>=[
  ['OAuth 授权被取消或拒绝，请重新连接并完成授权。','OAuth 授权被取消或拒绝，请重新连接并完成授权。'],
  // 宿主原文是匹配片段（不直接展示），界面显示词条文案
  ['OAuth 凭据无效或授权码已过期，请重新连接并完成授权。','OAuth 授权无效或授权码已过期，请重新连接并完成授权。'],
  ['OAuth 回调验证失败（state 不匹配或已超时），请重新发起授权。','OAuth 回调验证失败（state 不匹配或已超时），请重新发起授权。'],
  ['授权已过期或被吊销，请重新连接并完成 OAuth 授权。','授权已过期或被吊销，请重新连接并完成 OAuth 授权。'],
  ['服务器部署需在配置文件中设置 oauth.publicCallbackUrl 才能使用 OAuth 授权。','服务器部署需在配置文件中设置 oauth.publicCallbackUrl 才能使用 OAuth 授权。'],
  ['连接器 teloa.mcp-figma 暂不可用：厂商只允许白名单审批的客户端，Teloa 官方客户端尚未获批。','此连接需要厂商审核，当前版本暂不支持（等待白名单获批）。'],
 ]
 for(const [message,expected] of cases){
  assert.equal(view.oauthRecordErrorText(tt,message),expected,message)
  assert.equal(view.oauthFailureText(tt,'zh-CN',Object.assign(new Error(message),{code:'teloa/invalid-input'})),expected,message)
 }
 // 宿主 connectFailureReason 的三条固定文案（授权后建连失败）按原文显示，不被兜底覆盖；仅整句精确命中
 for(const fixed of ['无法连接到服务：请检查网络或服务是否可用。','服务返回错误，连接未建立；请稍后重试。'])assert.equal(view.oauthRecordErrorText(tt,fixed),fixed)
 // 密钥或授权被拒绝：新版宿主原文与已落盘的旧版原文（凭据被拒绝…）都显示为当前界面语言的词条，不落成未知错误
 for(const stored of ['密钥或授权被拒绝：请检查密钥是否正确、授权是否已过期或权限不足。','凭据被拒绝：请检查凭据是否正确、是否已过期或权限不足。']){
  assert.equal(view.oauthRecordErrorText(tt,stored),'密钥或授权被拒绝：请检查密钥是否正确、授权是否已过期或权限不足。')
  assert.equal(view.oauthRecordErrorText((key:string)=>translateMessage('en',key as never),stored),'The key or authorization was rejected. Check that the key is correct and that the authorization has not expired or lacks permissions.')
 }
 assert.equal(view.oauthRecordErrorText(tt,'无法连接到服务'),'操作未完成，请稍后重试。')
 assert.equal(view.oauthRecordErrorText(tt,'无法连接到服务：请检查网络或服务是否可用。 token=abc'),'操作未完成，请稍后重试。')
 assert.equal(view.oauthRecordErrorText(tt,undefined),'操作未完成，请稍后重试。')
 // 抛出的其他错误按错误码给固定文案，不透出宿主原文
 assert.equal(view.oauthFailureText(tt,'zh-CN',Object.assign(new Error('AS said evil'),{code:'teloa/dependency-unavailable'})),t('error.dependencyUnavailable'))
})

test('白名单制连接器：显示「暂不可用」固定文案，无连接按钮',()=>{
 const html=render({phase:{phase:'unsupported',reason:t('market.catalog.connector.oauthErrorAllowlist')}})
 assert.match(html,/此连接需要厂商审核/)
 assert.doesNotMatch(html,/去授权|测试连接/)
})

test('client_id 前端预校验：可见 ASCII、长度 1–512，且匹配配方 clientIdPattern',()=>{
 assert.equal(view.validClientId('123.456','^\\d+\\.\\d+$'),true)
 assert.equal(view.validClientId('abc','^\\d+\\.\\d+$'),false)
 assert.equal(view.validClientId('123.456 ','^\\d+\\.\\d+$'),false)
 assert.equal(view.validClientId('anything-visible',undefined),true)
 assert.equal(view.validClientId('',undefined),false)
 assert.equal(view.validClientId('含中文',undefined),false)
 assert.equal(view.validClientId('a'.repeat(513),undefined),false)
})

test('OAuth 轮询状态机：每 3 秒查询一次，connected / error 立即结束，5 分钟超时，可中止，瞬时失败继续',async()=>{
 const run=async(results:Array<unknown>,options:Record<string,unknown>={})=>{
  const waits:number[]=[],ids:string[]=[]
  const api={oauthStatus:async(id:string)=>{ids.push(id);const next=results.shift();if(next instanceof Error)throw next;return (next??{status:'pending-oauth'}) as {status:'pending-oauth'|'connected'|'error';errorMessage?:string}}}
  const result=await view.pollOAuthStatus(api,'11111111-1111-4111-8111-111111111111',{sleep:async(ms:number)=>{waits.push(ms)},...options})
  return {result,waits,ids}
 }
 const connected=await run([{status:'pending-oauth'},new Error('瞬时失败'),{status:'connected'}])
 assert.deepEqual(connected.result,{status:'connected'})
 assert.equal(connected.ids.length,3)
 assert.deepEqual(connected.waits,[3000,3000,3000])
 const failed=await run([{status:'error',errorMessage:'OAuth 授权被取消或拒绝，请重新连接并完成授权。'}])
 assert.deepEqual(failed.result,{status:'error',errorMessage:'OAuth 授权被取消或拒绝，请重新连接并完成授权。'})
 const timeout=await run([])
 assert.deepEqual(timeout.result,{status:'timeout'})
 assert.equal(timeout.ids.length,100)
 const controller=new AbortController();controller.abort()
 const aborted=await run([{status:'connected'}],{signal:controller.signal})
 assert.deepEqual(aborted.result,{status:'aborted'})
 assert.equal(aborted.ids.length,0)
})

test('OAuth 轮询：默认 sleep 响应中止，立即返回并清掉计时器（不拖住进程）',async()=>{
 const controller=new AbortController()
 const started=Date.now()
 const pending=view.pollOAuthStatus({oauthStatus:async()=>({status:'pending-oauth'})},'11111111-1111-4111-8111-111111111111',{signal:controller.signal,intervalMs:600_000})
 setTimeout(()=>controller.abort(),20)
 assert.deepEqual(await pending,{status:'aborted'})
 assert.ok(Date.now()-started<5_000)
})

test('OAuth 登记：已有记录时返回 existing，不再 add、不丢弃提示；无记录才 add 且只提交 oauth_client_id',async()=>{
 const existing=oauthRecord('pending-oauth')
 const calls:unknown[]=[]
 const api=(records:unknown[])=>({list:async()=>records,add:async(catalogId:string,creds?:Record<string,string>)=>{calls.push([catalogId,creds]);return oauthRecord('pending-oauth',{id:'22222222-2222-4222-8222-222222222222'})}})
 const found=await view.registerOAuthConnection(api([existing]) as never,'teloa.mcp-slack','123.456')
 assert.equal(found.existing,true)
 assert.equal(found.record.id,existing.id)
 assert.equal(calls.length,0)
 const added=await view.registerOAuthConnection(api([]) as never,'teloa.mcp-slack','123.456')
 assert.equal(added.existing,false)
 assert.deepEqual(calls,[['teloa.mcp-slack',{oauth_client_id:'123.456'}]])
 calls.length=0
 await view.registerOAuthConnection(api([]) as never,'teloa.mcp-supabase-remote',undefined)
 assert.deepEqual(calls,[['teloa.mcp-supabase-remote',undefined]])
 assert.match(t('market.catalog.connector.oauthExisting'),/已有连接/)
})

test('源码守卫：不自动跳转、无 dangerouslySetInnerHTML、样式只用 --teloa-* 令牌',async()=>{
 const {readFileSync}=await import('node:fs')
 const source=readFileSync(new URL('../src/client/McpConnectionView.tsx',import.meta.url),'utf8')
 assert.doesNotMatch(source,/dangerouslySetInnerHTML|window\.open|location\.(assign|replace|href\s*=)|openExternal/)
 const styles=readFileSync(new URL('../src/client/McpConnectionView.module.css',import.meta.url),'utf8')
 for(const [,name] of styles.matchAll(/var\((--[\w-]+)/g))assert.match(name!,/^--teloa-/,name)
 assert.doesNotMatch(styles,/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i)
})

test('M1：fullAccessWarning 时添加确认（oauth-new）、待授权与已连接界面都显著提示令牌为全权限；未设置时不提示',()=>{
 const phases=[{phase:'oauth-new',clientId:false,error:''},{phase:'pending-oauth',record:oauthRecord('pending-oauth'),authorizationUrl:'',error:'',deleteConfirm:false},{phase:'connected',record:oauthRecord('connected',{tools:[]}),deleteConfirm:false,oauth:true}]
 for(const phase of phases){
  assert.match(render({phase,fullAccessWarning:true}),/<p[^>]*role="note"[^>]*>令牌为全权限[^<]*只读仅依赖服务端参数/,phase.phase)
  assert.doesNotMatch(render({phase}),/令牌为全权限/,phase.phase)
 }
})

test('installing：首次安装中显示「正在安装」与耐心提示，不显示连接出错，按钮全部禁用',()=>{
 const record={id:'11111111-1111-4111-8111-111111111111',catalogId:'teloa.mcp-lark',serverName:'lark',status:'installing',createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z'}
 const html=render({phase:{phase:'installing',record}})
 assert.match(html,/正在安装/)
 assert.match(html,/3 分钟/)
 assert.doesNotMatch(html,/连接出错/)
 assert.doesNotMatch(html,/<button[^>]*>(测试连接|删除)/)
 assert.doesNotMatch(html,forbidden)
})

test('error + 安装错误码：按错误码给本地化文案（超时提示可重试），按钮为「重试连接」；宿主原文不直接展示',()=>{
 const base={id:'11111111-1111-4111-8111-111111111111',catalogId:'teloa.mcp-lark',serverName:'lark',status:'error',createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z',errorMessage:'宿主原文'}
 const timeout=render({phase:{phase:'error',record:{...base,errorCode:'install-timeout'},deleteConfirm:false}})
 assert.match(timeout,/安装超时/)
 assert.match(timeout,/重试/)
 assert.match(timeout,/重试连接/)
 assert.doesNotMatch(timeout,/宿主原文/)
 const failed=render({phase:{phase:'error',record:{...base,errorCode:'install-failed'},deleteConfirm:false}})
 assert.match(failed,/安装未完成/)
 assert.doesNotMatch(failed,/宿主原文/)
 const en=renderToStaticMarkup(createElement(view.McpConnectionViewPresentation as never,{...base,locale:'en',t:(key:string,params?:Record<string,string|number>)=>translateMessage('en',key as never,params),title:'Lark',onBack:noop,onConnect:noop,onDisconnect:noop,onDelete:noop,onDeleteConfirm:noop,busy:false,phase:{phase:'error',record:{...base,errorCode:'install-timeout'},deleteConfirm:false}} as never))
 assert.match(en,/timed out/i)
})

test('非 OAuth 连接：已落盘的旧宿主文案「凭据被拒绝…」与新文案都显示为当前界面语言的词条，英文界面不露中文；其他原文照常显示',()=>{
 const noop=()=>{}
 const base={id:'11111111-1111-4111-8111-111111111111',catalogId:'teloa.mcp-lark',serverName:'lark',status:'error',createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z'}
 const show=(locale:'zh-CN'|'en',errorMessage:string)=>renderToStaticMarkup(createElement(view.McpConnectionViewPresentation as never,{...base,locale,t:(key:string,params?:Record<string,string|number>)=>translateMessage(locale,key as never,params),title:'Lark',onBack:noop,onConnect:noop,onDisconnect:noop,onDelete:noop,onDeleteConfirm:noop,busy:false,phase:{phase:'error',record:{...base,errorMessage},deleteConfirm:false}} as never))
 for(const stored of ['凭据被拒绝：请检查凭据是否正确、是否已过期或权限不足。','密钥或授权被拒绝：请检查密钥是否正确、授权是否已过期或权限不足。']){
  const zh=show('zh-CN',stored)
  assert.match(zh,/<p class="error" role="alert">密钥或授权被拒绝：请检查密钥是否正确、授权是否已过期或权限不足。<\/p>/)
  assert.doesNotMatch(zh,/凭据/)
  const en=show('en',stored)
  assert.match(en,/The key or authorization was rejected\./)
  assert.doesNotMatch(en,/[\u4e00-\u9fff]/)
 }
 assert.match(show('zh-CN','无法连接到服务：请检查网络或服务是否可用。'),/无法连接到服务：请检查网络或服务是否可用。/)
})

test('connectWithInstallProgress：连接进行中轮询记录，看到 installing 即回调；连接结束停止轮询并返回结果；查询失败不影响连接',async()=>{
 const id='11111111-1111-4111-8111-111111111111'
 const rec=(status:string)=>({id,catalogId:'teloa.mcp-lark',serverName:'lark',status,createdAt:'2026-09-25T00:00:00.000Z',updatedAt:'2026-09-25T00:00:00.000Z'})
 let finish:(value:unknown)=>void=()=>{}
 const gets=[rec('saved'),new Error('瞬时失败'),rec('installing'),rec('installing')]
 let getCalls=0
 const api={connect:async()=>new Promise(done=>{finish=done}),get:async()=>{getCalls++;const next=gets.shift()??rec('installing');if(next instanceof Error)throw next;return next}}
 const seen:string[]=[]
 let ticks=0
 const pending=view.connectWithInstallProgress(api as never,id,(record:{status:string})=>seen.push(record.status),{sleep:async()=>{ticks++;if(ticks===4)finish(rec('connected'));await new Promise(done=>setTimeout(done,1))}})
 const result=await pending as {status:string}
 assert.equal(result.status,'connected')
 assert.deepEqual(seen,['installing'],'只在首次进入安装态时回调一次')
 const after=getCalls
 await new Promise(done=>setTimeout(done,20))
 assert.equal(getCalls,after,'连接结束后不再轮询')
 const failing={connect:async()=>{throw Object.assign(Error('x'),{code:'teloa/dependency-unavailable'})},get:async()=>rec('installing')}
 await assert.rejects(view.connectWithInstallProgress(failing as never,id,()=>{},{sleep:async()=>{}}),{code:'teloa/dependency-unavailable'})
})

test('secret-empty（规格 2026-09-27 §7.1）：header 变量显示目录说明与「将作为请求头 {name} 发送」；basic 显示用户名文本框 + 密码框；均不预填、提交后清空',async()=>{
 const vars=[
  {target:'header',name:'X-Api-Key',label:{'zh-CN':'PagerDuty API 密钥','en':'PagerDuty API key'},required:true},
  {target:'basic',userLabel:{'zh-CN':'Atlassian 账号邮箱','en':'Atlassian email'},label:{'zh-CN':'Atlassian API Token','en':'Atlassian API token'},required:true},
 ]
 const html=render({phase:{phase:'secret-empty',vars,serverName:'svc',error:''}})
 assert.match(html,/PagerDuty API 密钥/)
 assert.match(html,/将作为请求头 X-Api-Key 发送/)
 assert.match(html,/<input[^>]*type="password"[^>]*name="header_svc__x-api-key"/)
 assert.match(html,/Atlassian 账号邮箱/)
 assert.match(html,/<input[^>]*type="text"[^>]*name="basic_user_svc"/)
 assert.match(html,/Atlassian API Token/)
 assert.match(html,/<input[^>]*type="password"[^>]*name="basic_pass_svc"/)
 assert.equal([...html.matchAll(/type="password"/g)].length,2)
 assert.doesNotMatch(html,/value="/)
 // 提交即清空表单（write-only）：源码守卫 handleSubmit 在交出凭据前 reset
 const {readFileSync}=await import('node:fs')
 const source=readFileSync(new URL('../src/client/McpConnectionView.tsx',import.meta.url),'utf8')
 assert.match(source,/formRef\.current\.reset\(\)\s*\n\s*onConnect\(creds\)/)
})

test('审查修复（设计约束）：凭据表单的目录说明按界面语言取字段，缺省回落中文',()=>{
 const vars=[
  {target:'header',name:'X-Api-Key',label:{'zh-CN':'PagerDuty API 密钥','en':'PagerDuty API key'},required:true},
  {target:'basic',userLabel:{'zh-CN':'Atlassian 账号邮箱','en':'Atlassian email'},label:{'zh-CN':'Atlassian API 令牌','en':'Atlassian API token'},required:true},
 ]
 const tEn=(key:string,params?:Record<string,string|number>)=>translateMessage('en',key as never,params)
 const en=render({phase:{phase:'secret-empty',vars,serverName:'svc',error:''},locale:'en',t:tEn})
 for(const text of ['PagerDuty API key','Atlassian email','Atlassian API token','Sent as the X-Api-Key request header'])assert.ok(en.includes(text),text)
 for(const text of ['PagerDuty API 密钥','Atlassian 账号邮箱','Atlassian API 令牌'])assert.ok(!en.includes(text),text)
 const fallback=render({phase:{phase:'secret-empty',vars,serverName:'svc',error:''},locale:''})
 for(const text of ['PagerDuty API 密钥','Atlassian 账号邮箱','Atlassian API 令牌'])assert.ok(fallback.includes(text),text)
 const zhTw=render({phase:{phase:'secret-empty',vars,serverName:'svc',error:''},locale:'zh-TW'})
 assert.ok(zhTw.includes('PagerDuty API 密钥'))
})
