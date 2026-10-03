import {SessionController} from '@deepseek-ai/dsh-api-session-controller'
import type {Context} from '@deepseek-ai/cordis'
import {installNativeAdmission,nativeAdmissionMethods,requireNativeInputProvider} from './native-input-provider.ts'

/** 薄继承固定官方类；factory 便于在完整私有 npm 副本中验证同一装配。 */
export function createManagedSessionController(Base:typeof SessionController):typeof SessionController{
 class ManagedSessionController extends Base{
  static override inject=[...Base.inject,'teloaNativeInput']
  constructor(ctx:Context,config:ConstructorParameters<typeof SessionController>[1],internals?:ConstructorParameters<typeof SessionController>[2]){
   const provider=requireNativeInputProvider(ctx),methods=nativeAdmissionMethods(Base.prototype,'requireInputAdmission','installInputAdmission')
   super(ctx,config,internals)
   // 官方 Controller 构造不发布输入；其 plugin fiber 完成前安装固定策略。
   installNativeAdmission(this,methods,provider.admissions.controller)
  }
 }
 return ManagedSessionController
}
export const ManagedSessionController=createManagedSessionController(SessionController)
export default ManagedSessionController
