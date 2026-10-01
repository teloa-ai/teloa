import {producedFilePath} from './produced-files.ts'
import {sessionFileAddress} from './sidebar-right-service.ts'

export type ProducedFilePreviewPort={
  sessionAvailable:(sessionId:string)=>boolean
  workspaceCwd:(sessionId:string)=>string|undefined
  openResource:(address:string)=>void
}

/**
 * 产出文件一律交给原生 ui-sidebar-documentpreview：它自带 Markdown、代码、图片、PDF、HTML
 * 渲染与换行、重载，Teloa 不再维护第二套预览。会话与工作区边界仍由 Teloa 把关，
 * 因为原生按地址取文件、不知道这条路径是哪一轮产出的。
 */
export function previewProducedFileNatively(port:ProducedFilePreviewPort,sessionId:string,path:string):void{
  // 裸 Error 在界面上只会翻成“未知错误”；带既有错误码才能让用户看见真正的原因。
  if(!port.sessionAvailable(sessionId))throw Object.assign(Error('请重新打开文件的来源工作会话后预览。'),{code:'teloa/forbidden'})
  const relative=producedFilePath(path,port.workspaceCwd(sessionId))
  if(!relative)throw Object.assign(Error('该文件不在当前工作空间可预览范围内。'),{code:'teloa/invalid-input'})
  // 原生按地址认领类型；没有类型认得这条地址时 openResource 会抛，归因为依赖不可用而不是用户写错。
  try{port.openResource(sessionFileAddress(sessionId,relative))}
  catch(cause){throw Object.assign(Error('原生文档预览暂不可用。'),{code:'teloa/dependency-unavailable',cause})}
}
