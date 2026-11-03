import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import {SessionId,SessionSeq} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import * as api from '../src/stopped-task-run-inspection.ts'

for(const compression of ['none','zstd'] as const)test('维护只读快照保留已有输入历史与物理日志，拒绝截断：'+compression,async t=>{
 const inspect=Reflect.get(api,'readStoppedSubmissionSnapshot')
 assert.equal(typeof inspect,'function','缺少仅固定日志、不推断未发布的离线快照入口')
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-maintenance-snapshot-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(Jsonl,{root:join(root,'sessions'),compression})
 const run={sessionId:'original-'+randomUUID(),agentPresetId:'teloa-standard'},id=SessionId(run.sessionId)
 const handle=await ctx.sessionPersistence.create({id,version:4,createdAt:Date.now(),cwd:root,isSeeded:false,agentPreset:run.agentPresetId})
 const message=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'原历史输入必须保留'}]})
 await handle.append([{type:'user/message',seq:SessionSeq(0),time:Date.now(),surfaceOp:'append',data:message}]);await handle.flush();await handle.close()
 const path=await Reflect.get(ctx.sessionPersistence,'resolveCurrentLog').call(ctx.sessionPersistence,id),before=await readFile(path)
 const snapshot=await inspect({dshHome:root,expectedCwd:root,run})
 assert.equal(snapshot.logCut,0);assert.equal(snapshot.fileSha256,createHash('sha256').update(before).digest('hex'))
 assert.equal(snapshot.path,path);assert.deepEqual(await readFile(path),before)
 assert.equal(ctx.get('agents' as never),undefined)
 await writeFile(path,compression==='none'?Buffer.concat([before,Buffer.from('{"type":')]):before.subarray(0,before.length-2))
 await assert.rejects(inspect({dshHome:root,expectedCwd:root,run}))
})

test('已知未发布维护读取保留旧completed历史，拒绝目标输入和新请求header',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-unpublished-snapshot-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(Jsonl,{root:join(root,'sessions'),compression:'none'})
 const run={sessionId:'unpublished-'+randomUUID(),agentPresetId:'teloa-standard',nativeRequestId:randomUUID()},id=SessionId(run.sessionId)
 const handle=await ctx.sessionPersistence.create({id,version:4,createdAt:Date.now(),cwd:root,isSeeded:false,agentPreset:run.agentPresetId})
 const message=createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'原首报历史保留'}]})
 await handle.append([{type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},{type:'user/message',seq:SessionSeq(1),time:2,surfaceOp:'append',data:message},{type:'turn/end',seq:SessionSeq(2),time:3,data:{turn:1,reason:'completed'}}] as never)
 await handle.flush()
 const first=await api.readStoppedSubmissionSnapshot({dshHome:root,expectedCwd:root,run,requireNotPublished:true})
 assert.equal(first.notPublished,true);assert.equal(first.logCut,2)
 const queued=createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:'已有目标输入不得当作未发'}]})
 await handle.append([{type:'agent/inbox/spliced',seq:SessionSeq(3),time:4,data:{target:'next-turn',start:0,inserted:[queued]}}] as never)
 await handle.flush();await handle.close()
 await assert.rejects(api.readStoppedSubmissionSnapshot({dshHome:root,expectedCwd:root,run,requireNotPublished:true}))
 assert.equal((await api.readStoppedSubmissionSnapshot({dshHome:root,expectedCwd:root,run})).logCut,3,'原unknown快照语义不被已知未发规则放宽或替换')
})
