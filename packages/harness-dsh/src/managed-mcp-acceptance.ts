/**
 * 受管 MCP OAuth 端到端验收夹具（仅浏览器验收宿主）。
 *
 * 只有 `TELOA_BROWSER_ACCEPTANCE=1`（验收启动器设置）且 `TELOA_ACCEPTANCE_MCP_OAUTH_URL` 为
 * `http://127.0.0.1:<端口>/mcp`（验收脚本起的本地假 MCP / 假授权服务器）时才启用：
 * 追加两条 OAuth 夹具连接器和一条只读业务同步夹具，并让 OAuth 管理器只放行该夹具 origin 的授权服务器。
 * 其他任何情况返回 undefined，宿主照常只用官方目录与严格的 SSRF 防护。
 */
import {WorkError,type MarketCatalogConnectorEntry} from '@teloa/contract'
import {OAuthFlowManager,type OAuthFlowManagerOptions} from './managed-mcp-oauth.ts'

export type AcceptanceOAuthFixture={
 entry:(catalogId:string)=>MarketCatalogConnectorEntry|undefined
 createOAuthManager:(options:OAuthFlowManagerOptions)=>OAuthFlowManager
}

function fixtureEntry(id:string,serverName:string,url:string,requiresUserClientId:boolean):MarketCatalogConnectorEntry{
 const text={'zh-CN':'OAuth 验收夹具','en':'OAuth acceptance fixture'}
 return {
  format:'teloa.market-catalog-entry/v1',id,kind:'connector',delivery:'managed',version:'1.0.0',
  taxonomy:{functions:['automation'],industries:['general']},upstream:null,
  connector:{
   serverName,title:text,summary:text,
   auth:{kind:'oauth',supported:true,scopes:['mcp:read'],...(requiresUserClientId?{requiresUserClientId:true,clientIdPattern:'^acc-[a-z0-9]{4,32}$'}:{})},
   recipe:{transport:'streamable-http',url},
   tools:[{name:'list_tables',description:text,readOnly:true}],
   upstreamUrl:'https://teloa.ai',
  },
  modifications:[],license:{spdx:'MIT',files:['LICENSE']},
  compatibility:{status:'verified',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
  requires:{tools:[],network:true,runtimes:[]},
  review:{status:'approved',reviewedAt:'2026-09-26',reviewer:'Teloa'},
 }
}

function businessSyncEntry(url:string):MarketCatalogConnectorEntry{
 const text={'zh-CN':'业务持续规则验收来源','en':'Business recurring rule acceptance source'}
 return {
  format:'teloa.market-catalog-entry/v1',id:'acceptance.mcp-business-sync',kind:'connector',delivery:'managed',version:'1.0.0',
  taxonomy:{functions:['automation'],industries:['general']},upstream:null,
  connector:{serverName:'acc_business_sync',title:text,summary:text,auth:{kind:'none'},
   recipe:{transport:'streamable-http',url},tools:[{name:'list_items',description:text,readOnly:true},{name:'list_race_items',description:text,readOnly:true}],upstreamUrl:'https://teloa.ai'},
  modifications:[],license:{spdx:'MIT',files:['LICENSE']},
  compatibility:{status:'verified',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
  requires:{tools:[],network:true,runtimes:[]},
  review:{status:'approved',reviewedAt:'2026-09-30',reviewer:'Teloa'},
 }
}

export function acceptanceOAuthFixture(env:Record<string,string|undefined>):AcceptanceOAuthFixture|undefined{
 const raw=env.TELOA_ACCEPTANCE_MCP_OAUTH_URL
 if(env.TELOA_BROWSER_ACCEPTANCE!=='1'||!raw)return undefined
 const bad=()=>new WorkError('teloa/invalid-input','验收夹具地址只接受 http://127.0.0.1:<端口>/mcp。')
 let url:URL
 try{url=new URL(raw)}catch{throw bad()}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/mcp'||url.search||url.hash||url.username||url.password)throw bad()
 const entries=new Map([
  fixtureEntry('acceptance.mcp-oauth-dcr','acc_oauth',url.toString(),false),
  fixtureEntry('acceptance.mcp-oauth-user','acc_oauth_user',url.toString(),true),
  businessSyncEntry(url.toString()),
 ].map(entry=>[entry.id,entry]))
 return {
  entry:catalogId=>entries.get(catalogId),
  createOAuthManager:options=>new OAuthFlowManager({...options,allowedLoopbackOrigin:url.origin}),
 }
}
