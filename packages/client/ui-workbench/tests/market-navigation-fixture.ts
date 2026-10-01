import type {MarketCatalogConnectorEntry,MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import type {ManagedMcpConnectionRecord} from '../src/client/mcp-connections-api.js'

export const connectorEntry=(id='teloa.remote'):MarketCatalogConnectorEntry=>({
 format:'teloa.market-catalog-entry/v1',id,kind:'connector',delivery:'managed',version:'1.0.0',taxonomy:{functions:['communication'],industries:['general']},upstream:null,
 connector:{serverName:id==='teloa.remote'?'remote':'legacy',title:{'zh-CN':id==='teloa.remote'?'官方远程连接器':'旧连接器',en:id==='teloa.remote'?'Official remote connector':'Legacy connector'},summary:{'zh-CN':'连接工作资料。',en:'Connect work materials.'},auth:{kind:'none'},recipe:{transport:'streamable-http',url:'https://example.com/mcp'},tools:[],upstreamUrl:'https://example.com/'},
 modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-27',reviewer:'Teloa'},
})
export const navigationSkill=():MarketCatalogUpstreamSkillEntry=>({
 format:'teloa.market-catalog-entry/v1',id:'codex.legacy',kind:'skill',delivery:'upstream',version:'1.0.0',taxonomy:{functions:['communication'],industries:['general']},
 skill:{name:'legacy',title:{'zh-CN':'旧工具说明',en:'Legacy tool notes'},summary:{'zh-CN':'历史工具的来源说明。',en:'Source notes for a legacy tool.'}},
 upstream:{kind:'github',repository:{host:'github.com',owner:'example',repo:'skills'},commit:'a'.repeat(40),path:'skills/legacy',files:[{path:'SKILL.md',gitBlob:'b'.repeat(40),sha256:'c'.repeat(64),size:1}]},
 origin:{marketplace:'codex',installs:null,installsLabel:'',countedAt:'2026-09-27'},alternatives:[{entryId:'teloa.legacy',marketplace:'teloa',installs:null},{entryId:'teloa.remote',marketplace:'teloa',installs:null,recommended:true}],unsupportedComponents:[],modifications:[],license:{spdx:'NOASSERTION',files:[]},
 compatibility:{status:'unsupported',teloa:'>=0.2.0-alpha.7',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:false,runtimes:[]},review:{status:'approved',reviewedAt:'2026-09-27',reviewer:'Teloa'},
})
export const connectionRecord=(catalogId:string,status:ManagedMcpConnectionRecord['status']='connected'):ManagedMcpConnectionRecord=>({id:catalogId==='teloa.legacy'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222',catalogId,serverName:catalogId==='teloa.legacy'?'legacy':'remote',status,tools:[],createdAt:'2026-09-27T00:00:00.000Z',updatedAt:'2026-09-27T00:00:00.000Z'})
