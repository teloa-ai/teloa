import {WorkError} from './work-error.ts'

export type TaskCompletionPolicy={kind:'manual'}|{kind:'verified';verifier:'system-digest'|'material-version-summary';verifierVersion:number;authorizationVersion:number}
export type CompletionCandidate={runId:string;terminalEventSeq:number;artifactIds:string[];receiptIds:string[]}
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','本轮完成策略或候选证据格式不正确。')
function exact(input:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))throw invalid()
 return input as Record<string,unknown>
}
export function readTaskCompletionPolicy(input:unknown):TaskCompletionPolicy{
 if(input===undefined)return {kind:'manual'}
 const row=exact(input,['kind','verifier','verifierVersion','authorizationVersion'])
 if(row.kind==='manual'){if(Object.keys(row).length!==1)throw invalid();return {kind:'manual'}}
 if(row.kind!=='verified'||Object.keys(row).length!==4||!['system-digest','material-version-summary'].includes(String(row.verifier))||!positive(row.verifierVersion)||!positive(row.authorizationVersion))throw invalid()
 return {kind:'verified',verifier:row.verifier as 'system-digest'|'material-version-summary',verifierVersion:row.verifierVersion,authorizationVersion:row.authorizationVersion}
}
export function readCompletionCandidate(input:unknown):CompletionCandidate{
 const row=exact(input,['runId','terminalEventSeq','artifactIds','receiptIds'])
 const ids=(value:unknown):string[]=>{if(!Array.isArray(value)||value.length>64||!value.every(uuid)||new Set(value).size!==value.length)throw invalid();return [...value]}
 if(Object.keys(row).length!==4||!uuid(row.runId)||!positive(row.terminalEventSeq))throw invalid()
 return {runId:row.runId,terminalEventSeq:row.terminalEventSeq,artifactIds:ids(row.artifactIds),receiptIds:ids(row.receiptIds)}
}
