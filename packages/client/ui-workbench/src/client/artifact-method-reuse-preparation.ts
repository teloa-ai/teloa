import {methodReuseReference,type MethodReuseTarget,WorkError} from '@teloa/contract'
import type {Artifact} from './artifact-preview.ts'
import type {TeloaTranslate} from './i18n/index.ts'

/** 预览和旧版不能作为新方法的稳定来源；真正的来源权限仍由宿主按固定引用核对。 */
export function canPrepareArtifactMethodReuse(artifact:Artifact|undefined,version:number):boolean{
 const latest=artifact?.versions.at(-1)
 if(artifact?.storage!=='persistent'||!latest||latest.number!==version||!latest.source.ref.id||!['session','task'].includes(latest.source.ref.kind))return false
 try{methodReuseReference({artifactId:artifact.id,version});return true}catch{return false}
}

/** 只准备本人命令，不保存、安装或启用；标题不参与授权解析。 */
export function artifactMethodReusePreparation(artifact:Artifact,version:number,target:MethodReuseTarget,t:TeloaTranslate){
 if(!canPrepareArtifactMethodReuse(artifact,version))throw new WorkError('teloa/source-unavailable','请从已保存成果的最新版本重新准备。')
 const current=artifact.versions.at(-1)!,reference=methodReuseReference({artifactId:artifact.id,version})
 const lines=[t(target==='skill'?'artifact.method.prompt.skill':'artifact.method.prompt.plan'),'','## '+current.title.split(/\r?\n/).join('\n## '),'',reference]
 // 复用普通会话原生的显式技能创建手势，不假定已加载或已安装创建器。
 if(target==='skill')lines.unshift('/teloa-skill-creator','')
 return {sourceId:'artifact-method:'+reference+':'+target,sourceKind:'home' as const,sourceVersion:version,title:current.title,text:lines.join('\n')}
}
