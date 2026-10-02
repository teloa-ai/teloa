import type {Context} from '@deepseek-ai/cordis'
import {randomUUID} from 'node:crypto'
import OfficialProductTelemetry,{type Config,type ProductTelemetryRecord} from '@deepseek-ai/dsh-host-product-telemetry-otel'
import {sanitizeProductEvent} from '@teloa/contract'
import {securityEnv,launchSnapshot,processLayerEnv} from './launch-env.ts'
import {detectExclusion,readOrCreateInstallId} from './usage-stats.ts'

/** 复用官方 OTel 队列、传输及退出排空；身份与字段由 Teloa 约束。 */
export default class TeloaProductTelemetry extends OfficialProductTelemetry{
 private readonly identity:Promise<string|undefined>
 private accepting=true
 constructor(ctx:Context,config:Config){
  super(ctx,config)
  const env=securityEnv(ctx)
  const exclusions={...env,...processLayerEnv(launchSnapshot(ctx),['CI','NODE_ENV'])}
  this.identity=detectExclusion(exclusions)||!env.TELOA_RUNTIME_ROOT?Promise.resolve(undefined):readOrCreateInstallId(env.TELOA_RUNTIME_ROOT).catch(()=>undefined)
  // 排空前停止接收，并等身份读取结束，避免退出后异步事件复活。
  ctx.effect(()=>async()=>{this.accepting=false;await this.identity})
 }
 override emit(record:ProductTelemetryRecord):void{
  const event=sanitizeProductEvent(record)
  if(!event||!this.accepting)return
  void this.identity.then(installationId=>{
   if(installationId&&this.accepting)super.emit({...event,body:event.eventName,attributes:{...event.attributes,installation_id:installationId,event_id:randomUUID(),platform:process.platform}})
  })
 }
}
