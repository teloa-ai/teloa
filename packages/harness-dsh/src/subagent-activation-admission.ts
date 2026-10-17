import type {SubagentRuntime,SubagentActivation,SubagentActivationSpec} from '@deepseek-ai/dsh-subagent'
import type {MessageId} from '@deepseek-ai/dsh-llm'
import type {SessionId} from '@deepseek-ai/dsh-session'

type Admission=(spec:SubagentActivationSpec,start:(spec:SubagentActivationSpec)=>Promise<SubagentActivation>)=>Promise<SubagentActivation>
type AdmissionKind='local'|'external'
const admissionHolder=Symbol('teloa.subagentActivationAdmission')
type Holder={run:(spec:SubagentActivationSpec,start:Parameters<Admission>[1],external:boolean)=>Promise<SubagentActivation>;install:(policy:Admission,kind:AdmissionKind)=>()=>void}
function createHolder():Holder{
 const policies=new Map<AdmissionKind,Admission>()
 return Object.freeze({
  async run(spec,start,external){
   if(external&&!policies.has('external'))throw Error('外部引擎执行准入尚未就绪。')
   const chain=[...policies.values()]
   const invoke=(index:number,next:SubagentActivationSpec):Promise<SubagentActivation>=>chain[index]?.(next,value=>invoke(index+1,value))??start(next)
   return invoke(0,spec)
  },
  install:(policy:Admission,kind:AdmissionKind)=>{
   if(policies.has(kind))throw Error('原生 activation 业务准入重复安装。')
   policies.set(kind,policy)
   return ()=>{if(policies.get(kind)===policy)policies.delete(kind)}
  },
 })
}

/** 只包裹官方受理边界；创建、执行、投递和释放仍由原生管理器拥有。 */
export function createActivationAdmissionRuntime(Base:typeof SubagentRuntime):typeof SubagentRuntime{
 class ActivationAdmissionRuntime extends Base{
  constructor(...args:ConstructorParameters<typeof SubagentRuntime>){
   super(...args)
   Object.defineProperty(this,admissionHolder,{value:createHolder(),writable:false,configurable:false})
  }
  override startActivation(spec:SubagentActivationSpec&{readonly childId:SessionId}):Promise<SubagentActivation&{readonly messageId:MessageId}>
  override startActivation(spec:SubagentActivationSpec):Promise<SubagentActivation>
  override startActivation(spec:SubagentActivationSpec):Promise<SubagentActivation>{
   const start=(next:SubagentActivationSpec)=>super.startActivation(next)
   const provider=this.getProvider(spec.provider)
   return (Reflect.get(this,admissionHolder) as Holder).run(spec,start,provider!==undefined&&provider.prepareContinuable===undefined)
  }
 }
 return ActivationAdmissionRuntime
}

export function installActivationAdmission(runtime:SubagentRuntime,admission:Admission,kind:AdmissionKind='local'):()=>void{
 const holder=Reflect.get(runtime,admissionHolder) as Holder|undefined
 if(!holder)throw Error('原生 activation 业务准入未装配。')
 return holder.install(admission,kind)
}
