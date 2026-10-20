import {SessionController} from '@deepseek-ai/dsh-api-session-controller'
import type {Context} from '@deepseek-ai/cordis'
import {installNativeAdmission,nativeAdmissionMethods,requireNativeInputProvider} from './native-input-provider.ts'
import {createModelCatalogReader,runnableModelCatalog,type ModelCatalogReader} from './model-catalog-readiness.ts'
import {createAutomaticModelDefault} from './automatic-model-default.ts'

/** 薄继承固定官方类；factory 便于在完整私有 npm 副本中验证同一装配。 */
export function createManagedSessionController(Base:typeof SessionController):typeof SessionController{
 class ManagedSessionController extends Base{
  static override inject=[...new Set([...Base.inject,'teloaNativeInput','settings','credentials'])]
  private readonly modelCatalogReader:ModelCatalogReader
  constructor(ctx:Context,config:ConstructorParameters<typeof SessionController>[1],internals?:ConstructorParameters<typeof SessionController>[2]){
   const provider=requireNativeInputProvider(ctx),methods=nativeAdmissionMethods(Base.prototype,'requireInputAdmission','installInputAdmission')
   super(ctx,config,internals)
   this.modelCatalogReader=createModelCatalogReader(ctx,()=>super.modelCatalog())
   ctx.provide('teloaModelCatalog',this.modelCatalogReader)
   const automatic=createAutomaticModelDefault(ctx,this.modelCatalogReader)
   ctx.effect(()=>automatic.dispose)
   void automatic.refresh().catch(()=>{ctx.logger.warn('默认模型初始化暂未完成，请在模型选择器核对。')})
   // 官方 Controller 构造不发布输入；其 plugin fiber 完成前安装固定策略。
   installNativeAdmission(this,methods,provider.admissions.controller)
  }
  override async modelCatalog(){return runnableModelCatalog(await this.modelCatalogReader.read())}
 }
 return ManagedSessionController
}
export const ManagedSessionController=createManagedSessionController(SessionController)
export default ManagedSessionController
