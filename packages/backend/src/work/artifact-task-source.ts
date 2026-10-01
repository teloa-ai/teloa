import type {Pool} from 'pg'
import {WorkError,type SavedArtifactSource} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'
/** 写入检查需持有有效关系共享锁，解除关联不能越过成果事务。 */
export async function taskArtifactSessions(db:Pick<Pool,'query'>,owner:string,id:string,writing:boolean):Promise<string[]>{
 await taskArtifactSource(db,owner,id,writing)
 const rows=await db.query("select session_id,conversation_id,version,object_version from teloa_object_conversations where owner_id=$1 and kind='task' and object_id=$2 and active=true order by session_id"+(writing?' for share':''),[owner,id])
 const ids=rows.rows.map(row=>{if(typeof row.session_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(row.session_id)||typeof row.conversation_id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(row.conversation_id)||!Number.isSafeInteger(row.version)||row.version<1||!Number.isSafeInteger(row.object_version)||row.object_version<1)throw new WorkError('teloa/storage-corrupt','任务来源会话关联损坏。');return row.session_id as string})
 if(new Set(ids).size!==ids.length)throw new WorkError('teloa/storage-corrupt','任务来源会话重复。')
 return ids
}
/** 写入时必须使用成果事务的连接；共享锁覆盖来源检查至成果提交。 */
export async function taskArtifactSource(db:Pick<Pool,'query'>,owner:string,id:string,writing:boolean):Promise<SavedArtifactSource>{
 if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')
 if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))throw new WorkError('teloa/invalid-input','任务身份不正确。')
 const rows=await db.query('select * from teloa_tasks where owner_id=$1 and id=$2'+(writing?' for share':''),[owner,id])
 if(!rows.rows[0])throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
 const task=readStoredTask(rows.rows[0])
 if(writing&&['completed','cancelled'].includes(task.state))throw new WorkError('teloa/conflict','原任务已结束，请通过跟进任务继续成果修订。')
 return {kind:'task',id:task.id,scope:task.scope,version:`${task.version} · ${task.updatedAt}`,title:task.title}
}
