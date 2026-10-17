import {Service,type Context} from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import type {CredentialRef} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {SettingsPort} from './local-models-route.ts'
import {createPlatformModelAccess,isPlatformModelProvider,platformModelCredentialRef} from './platform-model-connection.ts'
import {resolveTeloaRuntime} from './runtime-paths.ts'
import {securityEnv} from './launch-env.ts'

/** 仅 Host 服务，没有 Remote 令牌读取接口；不写第二份模型配置或凭据。 */
export default class PlatformModelService extends Service{
 static inject=['settings','credentials','agents']
 static Config=z.object({allowLoopbackHttp:z.boolean().default(false)})
 readonly access:ReturnType<typeof createPlatformModelAccess>
 readonly runtimeRoot:string
 constructor(ctx:Context,config:{allowLoopbackHttp?:boolean}={}){
  super(ctx,'teloaPlatformModels')
  this.runtimeRoot=join(resolveTeloaRuntime(fileURLToPath(new URL('../../../',import.meta.url)),securityEnv(ctx)),'platform-model-auth')
  this.access=createPlatformModelAccess({settings:ctx.get('settings') as SettingsPort,credentials:{resolve:ref=>ctx.credentials.resolve(ref as CredentialRef)},allowLoopbackHttp:config.allowLoopbackHttp===true})
  const invalidate=()=>{
   this.access.invalidate()
   for(const agent of ctx.agents.list())if(agent.status==='running'&&isPlatformModelProvider(agent.session.requestContext()?.provider))agent.cancel({kind:'hook',reason:'platform-model/credentials-changed'},{keepInbox:true})
  }
  ctx.on('credentials/reference-updated',ref=>{if(ref===platformModelCredentialRef)invalidate()})
  ctx.on('settings/document-updated',namespace=>{if(namespace==='llm-pi-ai')invalidate()})
  ctx.effect(()=>()=>{invalidate();this.access.dispose()})
 }
}
