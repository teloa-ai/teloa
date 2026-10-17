import {WorkError,isRecord,businessObjectReference,type BusinessObjectReference} from './index.ts'
import {readBusinessRecordReceipt} from './business-records.ts'
export type BusinessObjectWorkLink={id:string;reference:BusinessObjectReference;sessionId:string;title:string;createdAt:string}
export type BusinessWorkResultVersion={workLinkId:string;slot:string;revision:number;digest:string;summary:string;state:'working'|'completed'|'blocked';source:{sessionId:string;messageId:string;seq:number};artifactVersions:readonly {artifactId:string;number:number}[];createdAt:string}
export type BusinessWorkLinkInput={requestId:string;reference:BusinessObjectReference;sessionId:string;title:string}
const bad=()=>new WorkError('teloa/invalid-input','业务工作与成果参数不正确。')
export function readBusinessWorkLink(value:unknown):BusinessWorkLinkInput{
 if(!isRecord(value)||Object.keys(value).some(k=>!['requestId','reference','sessionId','title'].includes(k))||typeof value.sessionId!=='string'||!value.sessionId.trim()||value.sessionId.length>200||typeof value.title!=='string'||!value.title.trim()||value.title.length>240)throw bad()
 return {...readBusinessRecordReceipt({requestId:value.requestId}),reference:businessObjectReference(value.reference),sessionId:value.sessionId,title:value.title}
}
export function readBusinessWorkResultPublish(value:unknown){
 if(!isRecord(value)||Object.keys(value).some(k=>!['requestId','workLinkId','slot','expectedRevision','summary','state','artifactVersions'].includes(k))||typeof value.slot!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(value.slot)||!Number.isSafeInteger(value.expectedRevision)||Number(value.expectedRevision)<0||typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>4000||!['working','completed','blocked'].includes(String(value.state)))throw bad()
 readBusinessRecordReceipt({requestId:value.workLinkId});const request=readBusinessRecordReceipt({requestId:value.requestId})
 const artifacts=value.artifactVersions??[]
 if(!Array.isArray(artifacts)||artifacts.length>50||artifacts.some(a=>!isRecord(a)||Object.keys(a).some(k=>!['artifactId','number'].includes(k))||typeof a.artifactId!=='string'||!a.artifactId||!Number.isSafeInteger(a.number)||Number(a.number)<1)||new Set(artifacts.map(a=>JSON.stringify(a))).size!==artifacts.length)throw bad()
 return {...request,workLinkId:value.workLinkId as string,slot:value.slot,expectedRevision:Number(value.expectedRevision),summary:value.summary,state:value.state as BusinessWorkResultVersion['state'],artifactVersions:artifacts as {artifactId:string;number:number}[]}
}
