import type {Context} from '@deepseek-ai/cordis'
import type {ToolDefinition} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,readTaskReferenceCitationPath} from '@teloa/contract'
import {isTaskKnowledgeReferenceId,taskReferenceReadTool,type TaskReferenceResult} from '@teloa/backend'
import {resolveSessionLineage} from './subagent-lineage.ts'
import {getToolResourceProvenance} from './tool-resource-provenance.ts'

type Read=(sessionId:string,args:{id:string;version:string},signal:AbortSignal)=>Promise<TaskReferenceResult>
/** 保留真实ToolRuntime工具体/取消/输出schema；不替换公共目录或以模型参数创建身份。 */
export function registerTaskReferenceReader(ctx:Context,read:Read):()=>void{
 let live=true
 const wrapped=new Map<ToolDefinition,{execute:ToolDefinition['execute'];meta:ToolDefinition['output']['presentationMeta'];ours:ToolDefinition}>()
 const provenance=getToolResourceProvenance(ctx)
 const install=(definition:ToolDefinition|undefined)=>{
  if(!definition||definition.name!==taskReferenceReadTool||wrapped.has(definition))return
  const execute=definition.execute,meta=definition.output.presentationMeta
  const adapted:ToolDefinition={...definition,output:{...definition.output},execute:async(args,exec)=>{
   if(!isRecord(args)||!isTaskKnowledgeReferenceId(args.id))return execute.call(definition,args,exec)
   exec.signal.throwIfAborted()
   if(!live)throw new WorkError('teloa/unavailable','资料读取服务已关闭。')
   if(!exec.agent||Object.keys(args).length!==2||typeof args.version!=='string'||!/^[a-f0-9]{64}$/.test(args.version))throw new WorkError('teloa/forbidden','资料读取缺少可信运行身份或固定版本。')
   const {root}=resolveSessionLineage(ctx,exec.agent.session)
   const value=await read(root.id,{id:args.id,version:args.version},exec.signal)
   exec.signal.throwIfAborted()
   if(!live)throw new WorkError('teloa/unavailable','资料读取服务已关闭。')
   if(value.id!==args.id||value.version!==args.version)throw new WorkError('teloa/invalid-host-response','资料读取返回了不同的固定来源。')
   if(value.citationPath!==undefined){const citation=readTaskReferenceCitationPath(value.citationPath)
    if(!citation||citation.sourceVersion!==value.version||!value.references.some(ref=>ref.id===citation.resourceId&&ref.version===citation.resourceVersion))throw new WorkError('teloa/invalid-host-response','资料引用与固定来源不一致。')
   }
   return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}
  }}
  const ours=provenance.wrapDefinition(adapted,(_definition,args)=>isRecord(args)&&isTaskKnowledgeReferenceId(args.id)?{kind:'plugin',providerId:'@teloa/harness-dsh',name:'registered-knowledge-reference',state:'used'}:undefined)
  definition.execute=ours.execute
  if(ours.output.presentationMeta)definition.output.presentationMeta=ours.output.presentationMeta;else delete definition.output.presentationMeta
  wrapped.set(definition,{execute,meta,ours})
 }
 const changed=ctx.on('tools/change',()=>install(ctx.tools.get(taskReferenceReadTool)))
 // scoped定义同样在其真实执行前装配，既有单调guard仍核对原定义对象身份。
 const before=ctx.on('tools/pre-execute',(exec,next)=>{if(exec.name===taskReferenceReadTool)install(ctx.tools.get(exec.name,exec.agent));return next()},{global:true})
 install(ctx.tools.get(taskReferenceReadTool))
 return ()=>{
  if(!live)return;live=false;changed();before()
  for(const [definition,state]of wrapped){
   if(definition.execute===state.ours.execute)definition.execute=state.execute
   if(definition.output.presentationMeta===state.ours.output.presentationMeta){if(state.meta)definition.output.presentationMeta=state.meta;else delete definition.output.presentationMeta}
  }
  wrapped.clear()
 }
}
