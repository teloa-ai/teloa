import {useMemo} from 'react'
import type {ConversationOverviewRegisteredArtifactRef} from './conversation-overview-artifacts.js'
import {DocumentPreview} from './DocumentPreview.js'
import {useI18n} from './i18n/provider.js'

export type ConversationOverviewArtifactPreviewProps=Readonly<{
 reference:ConversationOverviewRegisteredArtifactRef
 backLabel?:string
 onBack:()=>void
 onDownload:(reference:ConversationOverviewRegisteredArtifactRef)=>void|Promise<void>
 onSave?:((reference:Extract<ConversationOverviewRegisteredArtifactRef,{kind:'file'}>)=>Promise<void>)|undefined
}>

/** 注册成果的只读快照预览。来源与下载仍由原成果端口核验。 */
export function ConversationOverviewArtifactPreview({reference,onBack,onDownload,onSave,backLabel}:ConversationOverviewArtifactPreviewProps){
 const {t,dateTime}=useI18n()
 const imageBlob=useMemo(()=>reference.imageType?new Blob([reference.bytes],{type:reference.imageType}):null,[reference])
 const metadata=<>{reference.row.kind}{reference.version!==undefined?<> · v{reference.version}</>:reference.kind==='file'?<> · {t('artifactFiles.snapshotMeta',{bytes:reference.file.bytes,at:dateTime(reference.file.capturedAt)})}</>:null}</>
 return <DocumentPreview identity={reference.row.id} label={reference.row.label} metadata={metadata} text={reference.text} previewKind={reference.previewKind} imageBlob={imageBlob} backLabel={backLabel} onBack={onBack} onDownload={()=>onDownload(reference)} onSave={onSave&&reference.kind==='file'&&!reference.artifactId?()=>onSave(reference):undefined}/>
}
