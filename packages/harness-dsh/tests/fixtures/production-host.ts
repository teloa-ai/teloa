import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {parse as parseYaml} from 'yaml'
import {SessionId} from '@deepseek-ai/dsh-session'
import {installNativeSessions,installNativeHostServices} from './native-host-services.ts'

const presetDeclaration=parseYaml(readFileSync(new URL('../../../bundle/agent-presets/teloa-standard/agent.cordis.yml',import.meta.url),'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(source:string)=>({__jsExpr:source})}]} )[0].insert[0]
const require=createRequire(import.meta.url),officialRequire=createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const officialPresetRoot=join(dirname(officialRequire.resolve('@deepseek-ai/dsh-web-app/package.json')),'presets')
const officialPresets=Object.fromEntries(['standard','ptc','minimal','cordis'].map(id=>{
 const adapted=id!=='minimal'
 const path=adapted?new URL('../../../bundle/agent-presets/'+id+'.patch.yml',import.meta.url):join(officialPresetRoot,id+'.patch.yml')
 const parsed=parseYaml(readFileSync(path,'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(source:string)=>({__jsExpr:source})}]})
 return ['preset-'+id,(adapted?parsed[0]:parsed[0].insert[0]).config]
}))

export type RpcReply={ok:boolean;value?:unknown;receipt?:{requestId:string};error?:{code?:string}}
export type RpcHandler=(endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<RpcReply>

/**
 * @param options.agents 放开 `resolveAgent`，让执行准备能走完原生会话核验。
 *   默认仍按"本验收禁止模型运行"拒绝：解析 Agent 是发送的入口，只有确实要验执行准备
 *   的用例才开。开启后也只解析会话身份，`send` 一侧不提供，模型照样跑不起来。
 */
/**
 * 装配期复验安全钉时读的那份组合树；取值与 `packages/bundle/cordis.patch.yml` 钉住的逐字相同。
 * 传入 override 可把某一行改成被第三方补丁篡改后的样子，用来验证宿主拒绝启动。
 */
export function compositionEntries(override:Record<string,unknown>={}){
  const rows:Record<string,unknown>={
    'session-telemetry-otel':{mode:'DISABLED'},
    'session-log-deepseek':{enabled:false},
    'desktop-product-telemetry':{},
    'teloa-product-telemetry':{endpoint:'https://metrics.teloa.ai/v1/product-events',channel:'teloa_product_analytics',serviceName:'teloa-free'},
    'product-analytics':{enabled:true},
    // 组合树里 workspaceRoot 是 !!js 表达式节点，不是字符串。
    'sandbox-policy':{mode:'workspace-write',workspaceRoot:{__jsExpr:'process.cwd()'}},
    sandbox:{},
    approval:{policy:'ask'},
    tools:{mode:'native'},
    // 引擎侧的 ptc-runtime 保持启用（Agent 预设要靠它挂 workflowEngine）；关闭的是两条工具入口。
    'ptc-runtime':{},
    'tool-workflow':{},
    'tool-ralph':{},
    hmr:{root:[]},
    // 使用真实官方声明结构，安全钉核对 Loader 内实际的子插件正文。
    'agent-preset-registry':{default:'teloa-standard'},
    'teloa-agent-preset':presetDeclaration.config,
    ...officialPresets,
    permission:{presets:{'read-only':{sandbox:'read-only',approval:'ask'},'workspace-write':{sandbox:'workspace-write',approval:'ask'}}},
    // 上网的 provider 选择与抓取边界值：换掉 fetchProvider 等于换掉上游那整套 SSRF 保护，
    // 边界值被放大等于把跳转链、响应体与等待时间的面积交回补丁层。
    web:{searchProvider:'deepseek-official',fetchProvider:'http'},
    'web-search-deepseek':{baseURL:'https://api.deepseek.com/anthropic/v1',apiKeyEnv:'DEEPSEEK_API_KEY'},
    'web-fetch-http':{maxResponseBytes:5000000,maxBodyChars:100000,timeoutMs:30000,maxRedirects:3,userAgent:'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'},
    // 官方明文凭据行与附件准入行停用，由 Teloa 加密提供方与提交前密钥闸替换。
    credentials:{},
    'teloa-credentials':{store:'auto'},
    'attachment-local':{},
    'teloa-attachment-guard':{},
    ...override,
  }
  const disabledRows=new Set(['tool-workflow','tool-ralph','hmr','credentials','attachment-local','session-log-deepseek','desktop-product-telemetry'])
  // 上网三行还要钉住"这一行挂的是哪个包"：只按 id 定位挡不住同 id 换实现。
  const rowNames:Record<string,string>={hmr:'@deepseek-ai/dsh-hmr','agent-preset-registry':'@deepseek-ai/dsh-agent-preset-registry','teloa-agent-preset':'@deepseek-ai/dsh-agent-preset',web:'@deepseek-ai/dsh-web','web-search-deepseek':'@deepseek-ai/dsh-web-search-deepseek','web-fetch-http':'@deepseek-ai/dsh-web-fetch-http',credentials:'@deepseek-ai/dsh-credentials-local','teloa-credentials':'@teloa/harness-dsh/credentials','attachment-local':'@deepseek-ai/dsh-attachment-local','teloa-attachment-guard':'@teloa/harness-dsh/attachment-guard'}
  for(const id of Object.keys(officialPresets))rowNames[id]='@deepseek-ai/dsh-agent-preset'
  rowNames['session-log-deepseek']='@deepseek-ai/dsh-session-log-deepseek'
  rowNames['desktop-product-telemetry']='@deepseek-ai/dsh-host-product-telemetry-otel'
  rowNames['teloa-product-telemetry']='@teloa/harness-dsh/product-telemetry'
  rowNames['product-analytics']='@deepseek-ai/dsh-client-product-analytics'
  // `entry.id` 带所属子树前缀（真实宿主里是根 Include 的条目 id），定位键只能取 `options.id`。
  return {entries:function*(){
    for(const [id,config] of Object.entries(rows))yield {id:'profile-include:'+id,disabled:disabledRows.has(id),options:{id,config,...(rowNames[id]===undefined?{}:{name:rowNames[id]})}}
  }}
}

export function host(options:{agents?:boolean;composition?:{entries:()=>Iterable<unknown>}}={}){
  const ctx=new Context(),tools:unknown[]=[],modelCalls:unknown[]=[]
  // 装配期的组合安全钉复验读的是 Loader 条目表；没有它宿主按“无从复验”拒绝启动。
  ctx.provide('loader',options.composition??compositionEntries())
  let rpc:RpcHandler|undefined
  // 会话身份与运行配置要能对上：执行准备先按 preset 建会话，随后核验 inspect 与 Agent 三处一致。
  const sessionPresets=new Map<string,string>()
  // 登记表要带 path：装配期的"工作区是否覆盖仓库"提示与 conversations/create 的拒绝都按它判定。
  const workspaces=new Map<string,{id:string;path:string}>()
  ctx.provide('workspaceRegistry',{
    create:async(path:string)=>{
      const found=[...workspaces.values()].find(entry=>entry.path===path)
      if(found)return found
      const entry={id:'test-workspace-'+(workspaces.size+1),path}
      workspaces.set(entry.id,entry);return entry
    },
    get:(id:string)=>workspaces.get(id),
    list:()=>[...workspaces.values()],
  })
  ctx.provide('sessionController',{
    create:async(input:{sessionId?:string;agentPreset?:string}={})=>{
      const sessionId=input.sessionId??'unused'
      if(input.agentPreset!==undefined)sessionPresets.set(sessionId,input.agentPreset)
      await ctx.agents.create({sessionId:SessionId(sessionId),meta:{cwd:'/',...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})},agentOptions:{provider:'test',model:'test'}})
      return {sessionId,...(input.agentPreset===undefined?{}:{agentPreset:input.agentPreset})}
    },
    modelCatalog:async()=>({default:{provider:'test',model:'test'}}),
    fork:async()=>({sessionId:'unused'}),
    inspect:async(sessionId:string)=>({meta:{id:sessionId,...(sessionPresets.has(sessionId)?{agentPreset:sessionPresets.get(sessionId)}:{})}}),
    resolveAgent:async(sessionId:string)=>{
      if(!options.agents){modelCalls.push('unexpected');throw Error('本验收禁止模型运行。')}
      // 官方实例仅有初始权限事实，尚无任务轮次；此夹具不提供模型发送入口。
      return {agent:ctx.agents.get(SessionId(sessionId))}
    },
  })
  ctx.provide('tools',{register:(definition:unknown)=>{tools.push(definition)},schemas:()=>[],guard:()=>()=>{}})
  ctx.provide('skills',{
    list:async()=>[],
    registerProvider:(factory:(control:{invalidate:()=>void;signal:AbortSignal})=>unknown)=>{
      factory({invalidate:()=>{},signal:new AbortController().signal})
      return ()=>{}
    },
  })
  ctx.provide('agentPresets',{serviceFor:()=>undefined,acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??'default-agent'})})
  ctx.provide('fs',{})
  ctx.provide('fileReferences',{})
  ctx.provide('connection',{fetch:{register:()=>async()=>{}},rpc:{handle:(path:string,handler:RpcHandler)=>{assert.equal(path,'/teloa');rpc=handler;return ()=>{if(rpc===handler)rpc=undefined}}}})
  return {ctx,tools,modelCalls,ready:async(directory:string)=>{await installNativeSessions(ctx);await installNativeHostServices(ctx,directory)},get rpc(){assert.ok(rpc,'/teloa handler 尚未注册');return rpc}}
}
