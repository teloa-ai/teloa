import {WorkError} from './work-error.ts'

export type ArtifactInputSourceReference={artifactId:string;version:number}
const identity=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
/** 正式输入的一行固定来源；只是来源声明，实际消费仍由宿主核对本人、版本与可用性。 */
export function artifactInputSourceMarker(source:ArtifactInputSourceReference):string{
 if(!source||typeof source.artifactId!=='string'||!identity.test(source.artifactId)||!Number.isSafeInteger(source.version)||source.version<1)throw new WorkError('teloa/invalid-input','成果输入来源身份或版本不正确。')
 return `[teloa-artifact-source:${source.artifactId.toLowerCase()}:v${source.version}]`
}
/** 只解析完整单行，不扫描任意自然语言中的相似片段。 */
export function readArtifactInputSourceMarker(value:unknown):ArtifactInputSourceReference|null{
 if(typeof value!=='string')return null
 const match=/^\[teloa-artifact-source:([a-f0-9-]{36}):v([1-9][0-9]*)\]$/i.exec(value)
 if(!match||match[0]!==value||!identity.test(match[1]!)||!Number.isSafeInteger(Number(match[2])))return null
 return {artifactId:match[1]!.toLowerCase(),version:Number(match[2])}
}
