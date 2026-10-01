import type {AttentionLocalRecovery} from './attention-item.js'

type MarketItem={id:string;title:string}
type ArtifactDirectoryItem={id:string;source:{kind:string;id:string};versions:readonly {number:number}[]}
type ArtifactRecovery={key:string;artifactId:string;version:number;source:{kind:'session'|'task';id:string};title:string}
type GroupDirectoryItem={id:string;name:string;scope:string;archived:boolean}

export const unknownRecoveryOccurredAt='1970-01-01T00:00:00.000Z'

export type LocalRecoverySnapshot={
 taskMaterial?:{taskId:string;title:string;scope:string}|undefined
 artifacts:readonly ArtifactRecovery[]
 artifactDirectory:readonly ArtifactDirectoryItem[]
 group?:{id:string}|undefined
 groupDirectory:readonly GroupDirectoryItem[]
 industryLoad?:{id:string;item:MarketItem;scope:string}|undefined
 skillInstall?:{id:string;item:MarketItem;source?:{kind:'industry';loadId:string;itemInstanceId:string}}|undefined
}

export function localRecoveryItems(snapshot:LocalRecoverySnapshot):AttentionLocalRecovery[]{
 const items:AttentionLocalRecovery[]=[]
 if(snapshot.taskMaterial)items.push({id:'recovery:task-material:'+snapshot.taskMaterial.taskId,kind:'materials',source:'local-recovery',target:{kind:'task',id:snapshot.taskMaterial.taskId},title:snapshot.taskMaterial.title,reason:{kind:'message',key:'attention.recovery.taskMaterial'},scope:snapshot.taskMaterial.scope,occurredAt:unknownRecoveryOccurredAt})
 for(const recovery of snapshot.artifacts){
  const artifact=snapshot.artifactDirectory.find(item=>item.id===recovery.artifactId&&item.source.kind===recovery.source.kind&&item.source.id===recovery.source.id&&item.versions.some(version=>version.number===recovery.version))
  if(artifact)items.push({id:'recovery:artifact:'+recovery.key,kind:'review',source:'local-recovery',target:{kind:'artifact',source:recovery.source,artifactId:recovery.artifactId,version:recovery.version},title:recovery.title,reason:{kind:'message',key:'attention.recovery.artifact'},scope:'general',occurredAt:unknownRecoveryOccurredAt})
 }
 if(snapshot.group){const group=snapshot.groupDirectory.find(item=>item.id===snapshot.group!.id&&!item.archived);if(group)items.push({id:'recovery:group:'+group.id,kind:'review',source:'local-recovery',target:{kind:'group',id:group.id},title:group.name,reason:{kind:'message',key:'attention.recovery.group'},scope:group.scope,occurredAt:unknownRecoveryOccurredAt})}
 if(snapshot.industryLoad)items.push({id:'recovery:industry-load:'+snapshot.industryLoad.id,kind:'review',source:'local-recovery',target:{kind:'market',itemId:snapshot.industryLoad.item.id},title:snapshot.industryLoad.item.title,reason:{kind:'message',key:'attention.recovery.industryLoad'},scope:snapshot.industryLoad.scope,occurredAt:unknownRecoveryOccurredAt})
 if(snapshot.skillInstall){const target=snapshot.skillInstall.source?{kind:'industry-skill' as const,loadId:snapshot.skillInstall.source.loadId,itemInstanceId:snapshot.skillInstall.source.itemInstanceId}:{kind:'market' as const,itemId:snapshot.skillInstall.item.id};items.push({id:'recovery:skill-install:'+snapshot.skillInstall.id,kind:'review',source:'local-recovery',target,title:snapshot.skillInstall.item.title,reason:{kind:'message',key:'attention.recovery.skillInstall'},scope:'general',occurredAt:unknownRecoveryOccurredAt})}
 return items
}
