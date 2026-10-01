import type {Context} from '@deepseek-ai/cordis'
import LocalAttachmentStore,{type Config} from '@deepseek-ai/dsh-attachment-local'
import type {AdmittedPromptContentPart,AttachmentAdmissionPart} from '@deepseek-ai/dsh-attachment'
import {RemoteError} from '@deepseek-ai/dsh-typert-protocol'
import {promptSecretMessage} from '@teloa/contract'
import {checkPromptSecrets,storedSecretSource} from './prompt-secret-gate.ts'

/**
 * 个人会话的提交前密钥闸（规格 §6）。覆写官方准入：
 * controller 在建消息与 followup/steer 之前调用本方法（dsh-api-session-controller/lib/index.js:785 先于 :790-791），
 * 命中即抛 RemoteError，controller 原样转给客户端，不入队、不写会话日志、不发模型请求。IM 私聊经 sessionController.prompt 进入，同样经过本闸。
 * 不覆盖：子代理会话的纯文本 prompt（含用户在子代理会话输入框直接发送的）——dsh-subagent/lib/index.js:3191-3194 对全文本内容直接建消息、
 * 不调 admitPromptContent，只有带图片的子代理 prompt 才经过本方法（:3198）。该缺口列入规格 §6 与 §9-9。
 * 不声明 inject：没有凭据提供方时照常挂载，只跳过已存值比对（形态检测照拦）；否则缺提供方会让个人会话整体无法提交。
 */
export default class TeloaAttachmentStore extends LocalAttachmentStore{
 private readonly storedSecrets:()=>readonly string[]
 constructor(ctx:Context,config:Config){
  super(ctx,config)
  this.storedSecrets=storedSecretSource(()=>ctx.get('credentials'),message=>ctx.logger.warn(message))
 }
 override async admitPromptContent(content:readonly AttachmentAdmissionPart[]):Promise<AdmittedPromptContentPart[]>{
  const verdict=checkPromptSecrets(content.flatMap(part=>part.type==='text'?[part.text]:[]),this.storedSecrets)
  // details 走官方 bad-request 的 issues 口，只带原因与形态类别，留作客户端本地化的依据。
  if(!verdict.ok)throw new RemoteError('gateway/bad-request',promptSecretMessage(verdict.kinds),{issues:[{reason:'secret-in-message',kinds:verdict.kinds}]})
  return super.admitPromptContent(content)
 }
}
