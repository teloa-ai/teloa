import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {TeamId,TeamMessageId} from '@deepseek-ai/dsh-experimental-agent-team'
import {inspectLegacyTeamMessages} from '../../../scripts/核对DSH团队历史消息.mjs'

test('真实 JSONL 历史核对只读全部字节、不启动或重放旧工作',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-team-report-')),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(Persistence,{root,compression:'none'})
 const id=SessionId('legacy-report'),session=Session.create(id)
 session.append('team/message/queued',{version:2,teamId:TeamId('root'),message:{id:TeamMessageId('pending'),senderId:SessionId('child'),senderName:'reviewer',targetId:SessionId('root'),content:[{type:'text',text:'private old message'}]}})
 const handle=await ctx.sessionPersistence.create(session.header)
 try{await handle.append(session.snapshotEvents());await handle.flush()}finally{await handle.close()}
 const bytes=async()=>{
  const files=(await readdir(root,{recursive:true,withFileTypes:true})).filter(row=>row.isFile())
  return Promise.all(files.map(async row=>({path:join(row.parentPath,row.name),bytes:await readFile(join(row.parentPath,row.name))})))
 }
 const before=await bytes(),report=await inspectLegacyTeamMessages({root,sessionId:id,compression:'none'})
 assert.deepEqual(report,{sessionId:id,pending:[{teamId:'root',messageId:'pending',senderId:'child',senderName:'reviewer',targetId:'root'}],action:'review-required',automaticReplay:false})
 assert.equal(JSON.stringify(report).includes('private old message'),false)
 assert.deepEqual(await bytes(),before)
 assert.equal(ctx.get('agents' as never),undefined)
})
