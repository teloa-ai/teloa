/** 群协作的页面数据形状。没有远程发送、持久化或任务状态写入。 */
import type { GroupResource,GroupResourceRef,GroupResourceSnapshot } from './group-resources.ts'
export { builtinBusinessNames as collaborationScopes } from './business-directory.ts'
import type { BusinessScope } from './business-directory.ts'
export type CollaborationScope=BusinessScope
export type CollaborationGroup={id:string;name:string;scope:CollaborationScope;memberIds:string[];announcement:string;createdAt:string;updatedAt:string;pinned:boolean;archived:boolean;version:number}
export type CollaborationMessage={id:string;groupId:string;authorId:string;text:string;createdAt:string;rootId?:string;references?:GroupResourceSnapshot[]}
export type CollaborationPreview={groups:CollaborationGroup[];messages:CollaborationMessage[];drafts:Record<string,string>;resources:GroupResource[];referenceDrafts:Record<string,GroupResourceRef[]>}

export const emptyCollaboration=():CollaborationPreview=>({groups:[],messages:[],drafts:{},resources:[],referenceDrafts:{}})
