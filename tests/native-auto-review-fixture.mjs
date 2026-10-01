import {createRequire} from 'node:module'

const rootRequire=createRequire(new URL('../package.json',import.meta.url))
const cliRequire=createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'))
const harnessRequire=createRequire(new URL('../packages/harness-dsh/package.json',import.meta.url))
export const official=name=>import(cliRequire.resolve('@deepseek-ai/'+name))
export const autoReview=await import(harnessRequire.resolve('@deepseek-ai/dsh-experimental-auto-review'))
export const {Context}=await official('cordis')
export const {LlmRuntime,LlmAdapter,ToolCallId,createUserMessage}=await official('dsh-llm')
export const {SessionStore,SessionId}=await official('dsh-session')
export const {ToolRuntime,defineTool}=await official('dsh-tools')

export const textResponse=text=>[
 {type:'block-start',index:0,blockType:'text'},
 {type:'text-delta',index:0,text},
 {type:'block-end',index:0,block:{type:'text',text}},
 {type:'finish',reason:{kind:'stop'}},
]
export const toolResponse=(name,id)=>[
 {type:'block-start',index:0,blockType:'tool-call'},
 {type:'tool-call-delta',index:0,id:ToolCallId(id),name,argumentsDelta:'{}'},
 {type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId(id),name,arguments:'{}'}},
 {type:'finish',reason:{kind:'tool-calls'}},
]
// 仅替代外部 LLM 与不用来执行命令的 shell 默认值；会话、循环、权限与工具运行器均为官方实例。
export async function createRuntime(t){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(LlmRuntime)
 await ctx.plugin(SessionStore)
 await ctx.plugin((await official('dsh-session-projection')).SessionProjectionRegistry)
 await ctx.plugin((await official('dsh-system-prompt')).SystemPrompt)
 await ctx.plugin(ToolRuntime)
 await ctx.plugin((await official('dsh-agent')).AgentRegistry)
 await ctx.plugin((await official('dsh-agent-loop')).AgentLoop,{agents:[]})
 await ctx.plugin((await official('dsh-user-approval')).ApprovalService,{policy:'ask'})
 await ctx.plugin((await official('dsh-sandbox-policy')).SandboxPolicyService,{mode:'workspace-write'})
 ctx.provide('shell',{sandboxMode:'workspace-write'})
 await ctx.plugin((await official('dsh-permission-presets')).PermissionPresetService)
 class ScriptedAdapter extends LlmAdapter{
  requests=[];script=[]
  async resolveModel(provider,model){return {provider,id:model,name:model}}
  async *stream(options){this.requests.push(options);const response=this.script.shift();if(!response)throw Error('未预期的模型调用');yield* response}
 }
 const adapter=new ScriptedAdapter()
 ctx.llm.registerAdapter(['native-auto-review-test'],adapter)
 const create=async(id,meta={})=>(await ctx.agents.create({sessionId:SessionId(id),meta:{cwd:process.cwd(),...meta},agentOptions:{provider:'native-auto-review-test',model:'scripted'}})).agent
 return {ctx,adapter,create}
}
