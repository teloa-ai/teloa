import { sourceKey,sourceStamp,type Artifact,type ArtifactSection,type ArtifactSource } from './artifact-preview.ts'
import type { ArtifactMessage } from './artifact-native.ts'
import type { ArtifactFile } from './artifact-files.ts'
export type ArtifactDraft={followGoal?:string;title:string;body:string;note:string;feedback:string;feedbackId:string;stamp:string;messages?:ArtifactMessage[];files?:ArtifactFile[]}
export type ArtifactDrafts=Record<string,ArtifactDraft>
export const artifactDraftKey=(id:string,version:number,section:string)=>JSON.stringify([id,version,section])
export const hasArtifactRevision=(draft:ArtifactDraft|undefined,section:ArtifactSection)=>!!draft&&(draft.body!==section.text||!!draft.note||!!draft.feedbackId)
export function clearArtifactRevision(state:ArtifactDrafts,artifact:Artifact,version:number,sectionId:string):ArtifactDrafts{
  const key=artifactDraftKey(artifact.id,version,sectionId),draft=state[key],section=artifact.versions.find(item=>item.number===version)?.sections.find(item=>item.id===sectionId)
  if(!draft||!section)return state
  const next={...state}
  if(draft.feedback)next[key]={...draft,body:section.text,note:'',feedbackId:''};else delete next[key]
  return next
}
export function recoverArtifactRevision(state:ArtifactDrafts,artifact:Artifact,version:number,sectionId:string,source:ArtifactSource):ArtifactDrafts{
  if(sourceKey(artifact.source)!==sourceKey(source.ref))throw Error('稿件来源不一致。')
  const latest=artifact.versions.at(-1)!,section=artifact.versions.find(item=>item.number===version)?.sections.find(item=>item.id===sectionId)
  const key=artifactDraftKey(artifact.id,version,sectionId),draft=state[key],targetKey=artifactDraftKey(artifact.id,latest.number,sectionId)
  if(!section||!draft||!hasArtifactRevision(draft,section)||latest.number===version||!latest.sections.some(item=>item.id===sectionId))throw Error('没有可接续的旧基线段落草稿。')
  if(state[targetKey])throw Error('最新版此段已有草稿，请先查看并处理，不能覆盖。')
  return {...clearArtifactRevision(state,artifact,version,sectionId),[targetKey]:{...draft,note:`接续 v${version} 未保存草稿。${draft.note}`,feedback:'',feedbackId:'',stamp:sourceStamp(source)}}
}
