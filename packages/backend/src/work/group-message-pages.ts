import type {Pool,PoolClient} from 'pg'
import {WorkError,groupMessagePageInput,groupMessageSearchInput,readGroupMessagePage,readGroupMessageSearchResult,type GroupMessage,type GroupTopicSummary} from '@teloa/contract'
import {groupMessageScope} from './group-message-scope.ts'
import {groupMessageListColumns} from './group-message-body.ts'
import {readStoredGroupMessage,presentGroupMessages} from './group-message-presentation.ts'

type Scope=Awaited<ReturnType<typeof groupMessageScope>>
const columns=groupMessageListColumns.split(',').map(name=>'m.'+name).join(',')
const forbidden=()=>new WorkError('teloa/forbidden','消息游标不属于当前本人群或话题。')
export class GroupMessagePageService{
 private readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 private async cursor(db:PoolClient,scope:Scope,id:string){
  const row=(await db.query(`select m.id,m.created_at from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2 and ${scope.predicate} and m.id=$${scope.args.length+1}`,[...scope.args,id])).rows[0]
  if(!row)throw forbidden()
  return row as {id:string;created_at:Date}
 }
 private async rows(db:PoolClient,scope:Scope,condition:string,args:unknown[],limit:number,direction:'asc'|'desc',rootId?:string){
  const values=[...scope.args,...args,limit]
  const rows=(await db.query(`select ${columns} from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2 and ${scope.predicate}${rootId?' and m.id<>$3':''}${condition} order by m.created_at ${direction},m.id ${direction} limit $${values.length}`,values)).rows
  return rows
 }
 private async topics(db:PoolClient,owner:string,groupId:string,scope:Scope,roots:readonly string[]):Promise<GroupTopicSummary[]>{
  if(!roots.length)return []
  if((await db.query('select id from teloa_group_messages where owner_id=$1 and group_id=$2 and id=any($3::uuid[]) and root_id is null',[owner,groupId,roots])).rowCount!==roots.length)throw forbidden()
  const counts=(await db.query(`select m.root_id,count(*)::int n,count(distinct m.author_id)::int participants from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2 and m.root_id=any($3::uuid[]) and ${scope.thread} group by m.root_id`,[owner,groupId,roots])).rows
  const previews=(await db.query(`select ${groupMessageListColumns} from (select distinct_authors.*,row_number() over(partition by root_id order by created_at desc,id desc) participant from (select distinct on(m.root_id,m.author_id) ${columns} from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2 and m.root_id=any($3::uuid[]) and ${scope.thread} order by m.root_id,m.author_id,m.created_at desc,m.id desc) distinct_authors) ranked where participant<=3 order by created_at,id`,[owner,groupId,roots])).rows
  const messages=await presentGroupMessages(db,owner,previews.map(readStoredGroupMessage))
  return roots.map(rootId=>{const count=counts.find(row=>row.root_id===rootId);return {rootId,count:count?.n??0,participants:count?.participants??0,replies:messages.filter(row=>row.rootId===rootId)}})
 }
 async page(owner:string,input:unknown){
  const request=groupMessagePageInput(input),db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const scope=await groupMessageScope(db,owner,request),id=request.before??request.after??request.around,anchor=id?await this.cursor(db,scope,id):undefined,position=scope.args.length
   const pair=anchor?[anchor.created_at,anchor.id]:[]
   let rows:Record<string,unknown>[]
   if(request.around&&anchor){
    const before=await this.rows(db,scope,` and (m.created_at,m.id)<($${position+1}::timestamptz,$${position+2}::uuid)`,pair,Math.floor(request.limit/2),'desc',request.rootId)
    const center=(await db.query(`select ${columns} from teloa_group_messages m where m.owner_id=$1 and m.group_id=$2 and m.id=$3`,[owner,request.groupId,anchor.id])).rows
    const after=await this.rows(db,scope,` and (m.created_at,m.id)>($${position+1}::timestamptz,$${position+2}::uuid)`,pair,request.limit-before.length-center.length,'asc',request.rootId)
    rows=[...before.reverse(),...center,...after].filter(row=>row.id!==request.rootId)
   }else{
    const forward=!!request.after,condition=anchor?` and (m.created_at,m.id)${forward?'>':'<'}($${position+1}::timestamptz,$${position+2}::uuid)`:''
    rows=(await this.rows(db,scope,condition,pair,request.limit,forward?'asc':'desc',request.rootId))
    if(!forward)rows.reverse()
   }
   const first=rows[0],last=rows.at(-1),exists=async(row:Record<string,unknown>|undefined,operator:'<'|'>')=>row&&(await this.rows(db,scope,` and (m.created_at,m.id)${operator}($${position+1}::timestamptz,$${position+2}::uuid)`,[row.created_at,row.id],1,'asc',request.rootId)).length>0
   const older=await exists(first,'<')?String(first!.id):null,newer=await exists(last,'>')?String(last!.id):null
   if(request.rootId)rows.unshift((await db.query(`select ${columns} from teloa_group_messages m where m.owner_id=$1 and m.group_id=$2 and m.id=$3`,[owner,request.groupId,request.rootId])).rows[0])
   const items=await presentGroupMessages(db,owner,rows.map(readStoredGroupMessage)),roots=request.rootId?[request.rootId]:[...new Set([...items.filter(row=>row.rootId===null).map(row=>row.id),...(request.topicRoots??[])])]
   const result=readGroupMessagePage({schema:'teloa.group-message-page/v1',groupId:request.groupId,rootId:request.rootId??null,items,older,newer,topics:await this.topics(db,owner,request.groupId,scope,roots)})
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async search(owner:string,input:unknown){
  const request=groupMessageSearchInput(input),db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const scope=await groupMessageScope(db,owner,request),args:unknown[]=[...scope.args]
   // 群内全文搜索覆盖所有话题；指定话题时沿同一归属谓词。参数按字面子串匹配，不解释通配符。
   let condition=request.rootId?` and ${scope.predicate}`:''
   if(request.before){const cursorScope=request.rootId?scope:{...scope,predicate:'true'},anchor=await this.cursor(db,cursorScope,request.before);args.push(anchor.created_at,anchor.id);condition+=` and (m.created_at,m.id)<($${args.length-1}::timestamptz,$${args.length}::uuid)`}
   args.push(request.query);const match=`strpos(lower(coalesce(m.full_text,m.text)),lower($${args.length}))`;condition+=` and ${match}>0`;args.push(request.limit+1)
   const rows=(await db.query(`select ${columns},${scope.main} as main_channel,substring(coalesce(m.full_text,m.text) from greatest(${match}-60,1) for 400) as excerpt from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2${condition} order by m.created_at desc,m.id desc limit $${args.length}`,args)).rows,more=rows.length>request.limit,selected=rows.slice(0,request.limit),messages=await presentGroupMessages(db,owner,selected.map(readStoredGroupMessage))
   const result=readGroupMessageSearchResult({schema:'teloa.group-message-search/v1',groupId:request.groupId,rootId:request.rootId??null,query:request.query,items:messages.map((message,index)=>({message,rootId:selected[index]!.main_channel?null:message.rootId,excerpt:selected[index]!.excerpt})),next:more?messages.at(-1)!.id:null})
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
