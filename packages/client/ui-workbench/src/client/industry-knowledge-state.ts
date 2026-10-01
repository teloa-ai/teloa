import type {IndustryKnowledgeInstance,IndustryKnowledgeRequest} from './industry-knowledge-api.js'

export function industryKnowledgeAction(instance:IndustryKnowledgeInstance|undefined,pending:IndustryKnowledgeRequest|undefined){if(pending)return 'recover' as const;if(!instance)return 'create' as const;if(instance.state==='pending'||instance.state==='failed')return 'continue' as const;return 'none' as const}

export function mergeIndustryKnowledgeInstances(current:readonly IndustryKnowledgeInstance[],incoming:readonly IndustryKnowledgeInstance[]){
 const next=[...current]
 for(const row of incoming){const index=next.findIndex(item=>item.id===row.id||item.loadId===row.loadId&&item.itemInstanceId===row.itemInstanceId);if(index<0){next.push(row);continue}const previous=next[index]!;if(row.revision<previous.revision){if(row.resource&&(!previous.resource||row.resource.id===previous.resource.id&&row.resource.version>previous.resource.version))next[index]={...previous,state:row.resource.status,resource:row.resource,failure:null};continue}
  if(previous.resource&&(!row.resource||row.resource.version<previous.resource.version)){next[index]={...previous,revision:row.revision,updatedAt:row.updatedAt};continue}
  next[index]=row
 }
 return next
}
