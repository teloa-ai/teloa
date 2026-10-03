import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'
import type {Context} from '@deepseek-ai/cordis'
import type {createNativeProducerAdmissions} from './native-producer-admission.ts'
import {installNativeAdmission,nativeAdmissionMethods,requireNativeInputProvider} from './native-input-provider.ts'

type AdmissionOptions={requirePromptAdmission:true;admitPrompt:ReturnType<typeof createNativeProducerAdmissions>['subagent']}
type PatchedSubagentConstructor=typeof SubagentRuntime&{
 new(ctx:Context,config:ConstructorParameters<typeof SubagentRuntime>[1],options:AdmissionOptions):SubagentRuntime
}

/** 复用官方管理器；策略随构造参数交付，在其 agents injection 和首次发布前固定。 */
export function createManagedSubagentRuntime(Base:typeof SubagentRuntime):typeof SubagentRuntime{
 const PatchedBase=Base as PatchedSubagentConstructor
 class ManagedSubagentRuntime extends PatchedBase{
  static inject=[...(Reflect.get(Base,'inject')??[]) as string[],'teloaNativeInput']
  constructor(ctx:Context,config:ConstructorParameters<typeof SubagentRuntime>[1]){
   const provider=requireNativeInputProvider(ctx),methods=nativeAdmissionMethods(Base.prototype,'requirePromptAdmission','installPromptAdmission')
   super(ctx,config,{requirePromptAdmission:true,admitPrompt:provider.admissions.subagent})
   installNativeAdmission(this,methods,provider.admissions.subagent)
  }
 }
 return ManagedSubagentRuntime
}
export const ManagedSubagentRuntime=createManagedSubagentRuntime(SubagentRuntime)
export default ManagedSubagentRuntime
