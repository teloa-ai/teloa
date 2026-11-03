import {artifactInput,savedArtifactSource,type SavedArtifactSource} from './artifacts.ts'
import {WorkError} from './work-error.ts'

export type ArtifactWithdrawalInput={requestId:string;artifactId:string;expectedVersion:number;source:SavedArtifactSource}
export type ArtifactWithdrawal=ArtifactWithdrawalInput&{withdrawnAt:string}
export type ArtifactAvailability={artifactId:string;state:'available';withdrawal:null}|{artifactId:string;state:'withdrawn';withdrawal:ArtifactWithdrawal}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
export function readArtifactWithdrawalInput(value:unknown):ArtifactWithdrawalInput{
 const row=artifactInput(value,['requestId','artifactId','expectedVersion','source'])
 if(!uuid(row.requestId)||!uuid(row.artifactId)||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<1)throw new WorkError('teloa/invalid-input','撤回成果的请求身份或固定版本不正确。')
 return {requestId:row.requestId.toLowerCase(),artifactId:row.artifactId.toLowerCase(),expectedVersion:Number(row.expectedVersion),source:savedArtifactSource(row.source)}
}
export function readArtifactWithdrawal(value:unknown):ArtifactWithdrawal{
 const row=artifactInput(value,['requestId','artifactId','expectedVersion','source','withdrawnAt'])
 if(typeof row.withdrawnAt!=='string'||!Number.isFinite(Date.parse(row.withdrawnAt))||new Date(row.withdrawnAt).toISOString()!==row.withdrawnAt)throw new WorkError('teloa/invalid-input','成果撤回时间不正确。')
 return {...readArtifactWithdrawalInput({requestId:row.requestId,artifactId:row.artifactId,expectedVersion:row.expectedVersion,source:row.source}),withdrawnAt:row.withdrawnAt}
}
export function readArtifactAvailability(value:unknown):ArtifactAvailability{
 const row=artifactInput(value,['artifactId','state','withdrawal'])
 if(!uuid(row.artifactId))throw new WorkError('teloa/invalid-input','成果身份不正确。')
 const artifactId=row.artifactId.toLowerCase()
 if(row.state==='available'&&row.withdrawal===null)return {artifactId,state:'available',withdrawal:null}
 if(row.state==='withdrawn'){
  const withdrawal=readArtifactWithdrawal(row.withdrawal)
  if(withdrawal.artifactId===artifactId)return {artifactId,state:'withdrawn',withdrawal}
 }
 throw new WorkError('teloa/invalid-input','成果可用状态与固定对象不一致。')
}
