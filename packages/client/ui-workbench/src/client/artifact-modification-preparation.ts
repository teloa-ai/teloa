import {WorkError,artifactInputSourceMarker} from '@teloa/contract'
import type {Artifact} from './artifact-preview.ts'
import type {ArtifactFile} from './artifact-files.ts'
import type {CollaborationScope} from './collaboration-preview.ts'

export type ArtifactModificationFile=Pick<ArtifactFile,'id'|'sha256'|'path'>
const copy={
 'zh-CN':{heading:'请按以下要求修改已保存的成果。',target:'修改目标',whole:'整份成果',instruction:'本人修改要求',reference:'固定成果引用',boundary:'先核对指定版本及原文件。原件无法取得或摘要不一致时，先告知本人，不用其他版本代替。保留原成果与历史，修改结果另行交付；工具、资料及外部操作继续遵循本次工作的授权。'},
 'zh-Hant':{heading:'請按以下要求修改已儲存的成果。',target:'修改目標',whole:'整份成果',instruction:'本人修改要求',reference:'固定成果參照',boundary:'先核對指定版本及原檔案。無法取得原檔案或摘要不一致時，先告知本人，不使用其他版本代替。保留原成果與歷史，修改結果另行交付；工具、資料及對外操作繼續遵循本次工作的授權。'},
 en:{heading:'Revise the saved result according to the following request.',target:'Target',whole:'Entire result',instruction:'My requested changes',reference:'Fixed result reference',boundary:'Verify the specified version and original file first. If the original is unavailable or its hash differs, ask me instead of substituting another version. Preserve the original and its history; deliver changes separately. Tools, materials and external actions remain subject to the current work permissions.'},
} as const

/** 只准备一项新的工作输入；固定引用不授予文件/工具权限，也不覆盖已有成果。 */
export function artifactModificationPreparation(artifact:Artifact,version:number,instruction:string,file:ArtifactModificationFile|undefined,locale:string){
 const current=artifact.versions.at(-1),text=instruction.trim(),ref=current?.source.ref
 if(artifact.storage!=='persistent'||!current||current.number!==version||!ref||!['session','task'].includes(ref.kind)||!ref.id||!text||text.length>4000)throw new WorkError('teloa/source-unavailable','请从已保存成果的最新版本核对修改要求。')
 const selected=file?current.files?.find(item=>item.id===file.id&&item.sha256===file.sha256&&item.path===file.path):undefined
 if(file&&!selected)throw new WorkError('teloa/version-conflict','所选文件与该成果版本不一致，请重新核对。')
 const c=copy[/^zh-(hant|tw|hk)$/i.test(locale)?'zh-Hant':/^zh(?:-(hans|cn))?$/i.test(locale)?'zh-CN':'en']
 const reference={artifactId:artifact.id,version,source:ref,...(selected?{file:{id:selected.id,path:selected.path,sha256:selected.sha256,bytes:selected.bytes}}:{})}
 const goal=[c.heading,`${JSON.stringify(current.title)} · v${version}`,`${c.target}：${selected?.path??c.whole}`,'',`${c.instruction}：`,instruction,'',`${c.reference}：`,JSON.stringify(reference),artifactInputSourceMarker({artifactId:artifact.id,version}),'',c.boundary].join('\n')
 if(goal.length>7400)throw new WorkError('teloa/invalid-input','修改要求过长，请精简后继续。')
 return {artifactId:artifact.id,version,scope:current.source.scope as CollaborationScope,goal}
}
