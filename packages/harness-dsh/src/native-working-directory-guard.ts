import type {Agent} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import {WorkingDirectoryService} from '@deepseek-ai/dsh-working-directory'

/** 保留官方目录真源、序列化与日志；切目录和子级捕获均不得扩大原项目授权。 */
export class ProjectWorkingDirectory extends WorkingDirectoryService{
 private readonly roots=new WeakMap<Agent['session'],string>()
 private async authorized(agent:Agent,path:string,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted()
  // 原生 childSessionMeta 复制父 header.cwd；当前子目录另存事件。祖先字符串不能授予更大范围。
  const original=agent.session.header.cwd??this.defaultDirectory
  const options=signal===undefined?{}:{signal}
  const root=await this.ctx.fs.resolve(original,options),target=await this.ctx.fs.resolve(path,{...options,cwd:this.get(agent.session)})
  const retained=this.roots.get(agent.session)
  if(retained!==undefined&&retained!==root.targetKey)throw Error('原项目授权目录身份已变化，请重新核对工作文件夹。')
  if(!this.ctx.fs.contains(root,target))throw Error('当前目录超出原项目授权范围，请在目标项目中新建工作。')
  this.roots.set(agent.session,root.targetKey)
  signal?.throwIfAborted()
  return this.ctx.fs.processPath(target)
 }
 override async set(agent:Agent,path:string,signal?:AbortSignal):Promise<string>{
  // 传规范绝对路径给原服务，避免再次解释调用方的相对路径或链接拼写。
  return super.set(agent,await this.authorized(agent,path,signal),signal)
 }
 override async ensure(agent:Agent,signal?:AbortSignal):Promise<string>{
  await this.authorized(agent,this.get(agent.session),signal)
  return super.ensure(agent,signal)
 }
}
export default ProjectWorkingDirectory
