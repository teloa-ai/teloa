import {createRequire} from 'node:module'
import {isAbsolute} from 'node:path'
import {stat} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {pendingLegacyTeamMessages} from '../packages/harness-dsh/src/task-run-team-records.ts'

/** 仅显式选择的存储根；不加载 Agent、模型或重发旧队列。 */
export async function inspectLegacyTeamMessages({root,sessionId,compression='zstd'}){
 if(typeof root!=='string'||!isAbsolute(root)||!(await stat(root)).isDirectory()||typeof sessionId!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(sessionId)||!['none','zstd'].includes(compression))throw Error('请显式提供已有的绝对存储根、合法会话 ID 与匹配的压缩模式。')
 const program=createRequire(new URL('../package.json',import.meta.url)),native=createRequire(program.resolve('@deepseek-ai/dsh/package.json'))
 const {Context}=await import(pathToFileURL(native.resolve('@deepseek-ai/cordis')).href)
 const persistence=await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href)
 const {SessionId}=await import(pathToFileURL(native.resolve('@deepseek-ai/dsh-session')).href)
 const ctx=new Context()
 try{
  await ctx.plugin(persistence,{root,compression})
  const handle=await ctx.sessionPersistence.open(SessionId(sessionId),'read')
  try{return {sessionId,pending:pendingLegacyTeamMessages((await handle.read()).events),action:'review-required',automaticReplay:false}}
  finally{await handle.close()}
 }finally{await ctx.fiber.dispose()}
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const args=process.argv.slice(2)
 if(args.length<2||args.length>3){console.error('用法：node scripts/核对DSH团队历史消息.mjs <绝对存储根> <会话ID> [zstd|none]');process.exitCode=1}
 else try{console.log(JSON.stringify(await inspectLegacyTeamMessages({root:args[0],sessionId:args[1],compression:args[2]??'zstd'}),null,2))}
 catch{console.error('团队历史消息核对失败；未加载或重发任何工作，请核对会话、存储权限和压缩模式。');process.exitCode=1}
}
