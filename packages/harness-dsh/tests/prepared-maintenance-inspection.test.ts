import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {inspectPreparedMaintenanceNative} from '../src/prepared-maintenance-inspection.ts'

test('具名维护冷读：官方codec允许已完成工具历史，拒pending/未闭工具/原Run曾有输入与残缺文件',async t=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-prepared-maintenance-')),cwd=join(home,'workspace');await mkdir(cwd);t.after(()=>rm(home,{recursive:true,force:true}))
 const root=join(home,'sessions','--'+cwd.replace(/[/\\:]+/g,'-').replace(/^-+/,'')+'--'),meta=(id:string)=>({version:4,id,cwd,createdAt:1000,delegationDepth:0,isSeeded:false,agentPreset:'teloa-standard'}),input={dshHome:home,expectedCwd:cwd,sessionId:'prepared',agentPresetId:'teloa-standard'}
 const save=async(id:string,events:unknown[],tail='\n')=>{const dir=join(root,id);await mkdir(dir,{recursive:true});await writeFile(join(dir,'session.v4.jsonl'),[JSON.stringify({type:'session',...meta(id)}),...events.map(event=>JSON.stringify(event))].join('\n')+tail)}
 const event=(type:string,seq:number,data:unknown)=>({type,seq,time:1000+seq,data,...(['assistant/message','tool/result'].includes(type)?{surfaceOp:'append'}:{})})
 const message={id:'ordinary-input',role:'user',source:{kind:'user',rpcId:'ordinary-request'},content:[{type:'text',text:'仅合成历史，不执行'}]}
 await save('prepared',[])
 const history=[event('turn/start',0,{turn:1}),event('step/start',1,{turn:1,step:1}),{...event('assistant/message',2,{turn:1,step:1,stream:[],message:{id:'assistant',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture',turn:1,step:1},content:[{type:'tool-call',id:'completed-call',name:'fixture',arguments:'{}'}]}}),surfaceOp:'append'},event('tool/call',3,{turn:1,step:1,callId:'completed-call',name:'fixture',arguments:'{}'}),event('tool/result',4,{turn:1,step:1,message:{id:'result',role:'tool',toolCallId:'completed-call',source:{kind:'tool',callId:'completed-call'},name:'fixture',content:[{type:'text',text:'完成'}],isError:false}}),event('step/end',5,{turn:1,step:1}),event('turn/end',6,{turn:1,reason:{kind:'completed'}})]
 await save('ordinary',history);const before=await inspectPreparedMaintenanceNative(input);assert.equal(before.sessions,2);assert.equal(before.allInboxesEmpty,true);assert.equal(before.noOpenTurnOrTool,true)
 const canonicalHeader={agentPreset:'teloa-standard',createdAt:1000,cwd,delegationDepth:0,id:'prepared',isSeeded:false,version:4}
 assert.equal(before.original.snapshotSha256,createHash('sha256').update(JSON.stringify({events:[],header:canonicalHeader,inheritedEventCount:0})).digest('hex'),'与真实resident恢复检查点采用同一递归键序')
 const storages=join(home,'storages');await mkdir(storages);const schedule=join(storages,'schedule.json');await writeFile(schedule,JSON.stringify({unit:{name:'schedule',version:1},global:null,tables:{tasks:{pending:{status:'active'}}}}));await assert.rejects(inspectPreparedMaintenanceNative(input),{code:'teloa/conflict'});await rm(schedule)
 await save('ordinary',[event('agent/inbox/spliced',0,{target:'next-step',start:0,inserted:[message]})]);await assert.rejects(inspectPreparedMaintenanceNative(input),{code:'teloa/conflict'})
 await save('ordinary',history.slice(0,4));await assert.rejects(inspectPreparedMaintenanceNative(input),{code:'teloa/conflict'})
 await save('ordinary',history);await save('prepared',[event('agent/inbox/spliced',0,{target:'next-step',start:0,inserted:[message]}),event('agent/inbox/spliced',1,{target:'next-step',start:0,removedCount:1,inserted:[]})]);await assert.rejects(inspectPreparedMaintenanceNative(input),{code:'teloa/conflict'})
 await save('prepared',[],'');await assert.rejects(inspectPreparedMaintenanceNative(input),{code:'teloa/conflict'})
 await save('prepared',[]);assert.deepEqual(await inspectPreparedMaintenanceNative(input),before)
})
