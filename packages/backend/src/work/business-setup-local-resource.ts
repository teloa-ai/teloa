import {readBusinessConfigurationCandidateVersioned,type BusinessConfigurationCandidate,type BusinessConfigurationCandidateV2} from '@teloa/contract'

type Candidate=BusinessConfigurationCandidate|BusinessConfigurationCandidateV2

/** 市场资源只保存可携带声明；本人完整候选另在原草案中按版本、预览回执采用。 */
export function businessSetupPortableCandidate(candidate:Candidate):Candidate{
 const definitions=candidate.definitions.filter(row=>row.kind!=='source-mapping').map(row=>{
  if(row.kind!=='object-type'||!('defaultAction'in row.definition))return row
  const {defaultAction:_,...definition}=row.definition
  return {...row,definition}
 })
 return readBusinessConfigurationCandidateVersioned({...candidate,definitions})
}
