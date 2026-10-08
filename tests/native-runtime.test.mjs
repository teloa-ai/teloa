import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
const programRoot=dirname(dirname(fileURLToPath(import.meta.url)))

test('公共启动等待异步业务提供方就绪再核验，缺失装配有界拒绝',async()=>{
 const {waitManagedNativeServices}=await import('../scripts/runtime/native-runtime-entry.mjs')
 assert.equal(typeof waitManagedNativeServices,'function')
 let ready=false,reads=0
 const ctx={get:()=>{reads++;return ready?{}:undefined}}
 const pending=waitManagedNativeServices(ctx,{requireGoal:true,timeoutMs:1000})
 assert.ok(reads>0);ready=true;await pending
 await assert.rejects(waitManagedNativeServices({get:()=>undefined},{requireGoal:true,timeoutMs:20}),/装配.*超时/)
})

test('公共原生运行图只写私有副本，复用精确摘要；真实进程所有peer解析同一受管包，篡改拒绝',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-runtime-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const api=await import('../scripts/runtime/native-runtime.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error})
 assert.equal(typeof api.prepareNativeRuntime,'function','需要公共真实运行图准备入口')
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),original=require.resolve('@deepseek-ai/dsh-session'),before=await readFile(original)
 const plan=await api.prepareNativeRuntime({programRoot,runtimeRoot:root})
 assert.equal(plan.packages.length,12);assert.ok(plan.compatibilityAPIs['@deepseek-ai/dsh-goal-round-driver'].includes('installGoalInputAdmission'))
 assert.deepEqual(await api.prepareNativeRuntime({programRoot,runtimeRoot:root}),plan)
 assert.deepEqual(await readFile(original),before)
 const script=join(root,'probe.mjs')
 await writeFile(script,`import {createRequire} from 'node:module';import{pathToFileURL}from'node:url';const api=await import(${JSON.stringify(new URL('../scripts/runtime/native-runtime.mjs',import.meta.url).href)});const plan=await api.prepareNativeRuntime(${JSON.stringify({programRoot,runtimeRoot:root})});api.installNativeRuntime(plan);await api.prepareNativeRuntime(${JSON.stringify({programRoot,runtimeRoot:root})});const require=createRequire(${JSON.stringify(join(programRoot,'package.json'))}),dsh=createRequire(require.resolve('@deepseek-ai/dsh/package.json'));const session=await import(pathToFileURL(dsh.resolve('@deepseek-ai/dsh-session')).href),other=await import(pathToFileURL(createRequire(${JSON.stringify(join(programRoot,'packages/harness-dsh/package.json'))}).resolve('@deepseek-ai/dsh-session')).href);if(session.SessionStore!==other.SessionStore||typeof session.SessionStore.prototype.installAppendAdmission!=='function')throw Error('真实解析图分裂或缺补口');console.log('managed-native-graph');`)
 const result=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/managed-native-graph/)
 const session=plan.packages.find(row=>row.name==='@deepseek-ai/dsh-session');await writeFile(join(session.root,'lib/index.js'),'tampered')
 await assert.rejects(api.prepareNativeRuntime({programRoot,runtimeRoot:root}),/摘要|变化/);assert.deepEqual(await readFile(original),before)
})

test('公共源码启动真实官方 profile 的最终配置包含受管 input/session/subagent/Goal 与浏览器载体',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-profile-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const layout={programRoot,runtimeRoot:join(root,'runtime'),workspaceRoot:join(root,'workspace'),dshHome:join(root,'dsh'),profileName:'native-acceptance'}
 for(const path of [layout.runtimeRoot,layout.workspaceRoot,layout.dshHome])await mkdir(path,{recursive:true,mode:0o700})
 const script=join(root,'profile.mjs')
 await writeFile(script,`import{mkdir,readFile,symlink,writeFile}from'node:fs/promises';import{createRequire}from'node:module';import{dirname,join}from'node:path';import{pathToFileURL}from'node:url';const layout=${JSON.stringify(layout)},r=createRequire(join(layout.programRoot,'package.json')),sdk=await import(pathToFileURL(createRequire(r.resolve('@deepseek-ai/dsh/package.json')).resolve('@deepseek-ai/dsh-app-boot')).href),profileDir=join(layout.dshHome,'profiles',layout.profileName);sdk.initProfile(profileDir,[...sdk.PROFILE_TEMPLATES.web.bundles,'@teloa/bundle']);await mkdir(join(profileDir,'node_modules/@teloa'),{recursive:true});await symlink(join(layout.programRoot,'packages/bundle'),join(profileDir,'node_modules/@teloa/bundle'));const api=await import(${JSON.stringify(new URL('../scripts/runtime/native-runtime-entry.mjs',import.meta.url).href)}),prepared=await api.prepareManagedNativeProfile(layout),patch=JSON.parse(await readFile(prepared.patchFile));for(const id of ['teloa-native-input','teloa-managed-session-controller','teloa-managed-subagent','teloa-managed-goal-round-driver','teloa-client-face-session-controller'])if(!patch.some(row=>row.insert?.some(child=>child.id===id)))throw Error('缺实际受管配置 '+id);const row=patch.flatMap(row=>row.insert??[]).find(row=>row.id==='teloa-native-input'),identity=JSON.parse(await readFile(join(dirname(row.name),'package.json'))),sourceIdentity=JSON.parse(await readFile(join(layout.programRoot,'packages/harness-dsh/package.json')));if(identity.name!==sourceIdentity.name||identity.version!==sourceIdentity.version)throw Error('官方模型目录识别到不真实的公共载体身份');console.log('managed-profile');`)
 const result=spawnSync(process.execPath,[script],{env:{...process.env,DSH_HOME:layout.dshHome,TELOA_PROJECT_ROOT:programRoot,TELOA_RUNTIME_ROOT:layout.runtimeRoot,TELOA_WORKSPACE_ROOT:layout.workspaceRoot},encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/managed-profile/)
})

test('实际 profile 的公共冷恢复核对完整官方 Inbox 与固定逐根授权，缺票据或部分回复拒绝',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-restore-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const layout={programRoot,runtimeRoot:join(root,'runtime'),workspaceRoot:join(root,'workspace'),dshHome:join(root,'dsh'),profileName:'restore-acceptance'}
 for(const path of [layout.runtimeRoot,layout.workspaceRoot,layout.dshHome])await mkdir(path,{recursive:true,mode:0o700})
 const script=join(root,'restore.mjs')
 await writeFile(script,`
 import assert from 'node:assert/strict';import{mkdir,readFile,symlink}from'node:fs/promises';import{createRequire}from'node:module';import{join}from'node:path';import{pathToFileURL}from'node:url';
 const layout=${JSON.stringify(layout)},r=createRequire(join(layout.programRoot,'package.json')),official=createRequire(r.resolve('@deepseek-ai/dsh/package.json')),load=s=>import(pathToFileURL(official.resolve(s)).href),sdk=await load('@deepseek-ai/dsh-app-boot'),profileDir=join(layout.dshHome,'profiles',layout.profileName);
 sdk.initProfile(profileDir,[...sdk.PROFILE_TEMPLATES.web.bundles,'@teloa/bundle']);await mkdir(join(profileDir,'node_modules/@teloa'),{recursive:true});await symlink(join(layout.programRoot,'packages/bundle'),join(profileDir,'node_modules/@teloa/bundle'));
 const api=await import(${JSON.stringify(new URL('../scripts/runtime/native-runtime-entry.mjs',import.meta.url).href)}),prepared=await api.prepareManagedNativeProfile(layout),patch=JSON.parse(await readFile(prepared.patchFile));
 const row=patch.flatMap(row=>row.insert??[]).find(row=>row.id==='teloa-native-input');assert.match(row.name,/native-runtime-input\\.mjs$/);
 const input=await import(pathToFileURL(row.name).href);assert.equal(typeof input.createManagedNativeRestore,'function');
 const {Context}=await load('@deepseek-ai/cordis'),session=await load('@deepseek-ai/dsh-session'),llm=await load('@deepseek-ai/dsh-llm'),tools=await load('@deepseek-ai/dsh-tools'),agent=await load('@deepseek-ai/dsh-agent'),projection=await load('@deepseek-ai/dsh-session-projection'),prompt=await load('@deepseek-ai/dsh-system-prompt'),persistence=await load('@deepseek-ai/dsh-session-persistence-jsonl'),ctx=new Context();
 try{
 for(const plugin of [llm.LlmRuntime,session.SessionStore,projection.SessionProjectionRegistry,prompt.SystemPrompt,tools.ToolRuntime,agent.AgentRegistry])await ctx.plugin(plugin);
 await ctx.plugin(persistence.default,{root:join(layout.runtimeRoot,'sessions'),compression:'none'});await ctx.plugin((await load('@deepseek-ai/dsh-agent-loop')).AgentLoop,{agents:[]});
 const id=session.SessionId('profile-cold'),messages=[1,2].map(i=>llm.createUserMessage({source:{kind:'user',rpcId:'persisted-'+i},content:[{type:'text',text:'pending '+i}]})),events=messages.map((message,i)=>({type:'agent/inbox/spliced',seq:session.SessionSeq(i),time:i+1,data:{target:'next-turn',start:i,removedCount:0,inserted:[message]}})),cold=session.Session.create(id,events,session.Session.create(id).header,session.SessionLogOffset(0)),writer=await ctx.sessionPersistence.create(cold.header,{inheritedEventCount:0});await writer.append(cold.snapshotEvents());await writer.flush();await writer.close();
 const reader=await ctx.sessionPersistence.open(id,'read'),snapshot={header:reader.header,events:(await reader.read()).events,inheritedEventCount:Number(reader.inheritedEventCount)};await reader.close();
 const value={sessionId:id,snapshot,messages,signal:new AbortController().signal},restore=input.createManagedNativeRestore(ctx);assert.deepEqual(snapshot.events.slice(0,events.length),events);assert.equal(snapshot.inheritedEventCount,0);const inbox=ctx.sessionProjections.stateOf(session.Session.create(id,snapshot.events,snapshot.header,session.SessionLogOffset(0)),'inbox');assert.ok(prepared.providers.recoveryCandidate({snapshot,inbox}),JSON.stringify({inbox,header:snapshot.header,seqs:snapshot.events.map(e=>e.seq)}));assert.deepEqual(inbox['next-turn'],messages);
 await assert.rejects(restore(value),/恢复|票据/);
 let authorized=false,partial=false,revoked=false,calls=0;ctx.provide('teloaResidentInputAdmission',{authorizeRestoreRoots:async(_input,candidate)=>{calls++;if(!authorized)throw Error('无本人恢复票据');return{roots:partial?candidate.roots.slice(0,1):candidate.roots,assertCurrent(){if(revoked)throw Error('票据已失效')}}}});
 await assert.rejects(restore(value),/本人恢复票据/);authorized=true;partial=true;await assert.rejects(restore(value),/完整|根/);partial=false;
 const before=calls;await assert.rejects(restore({...value,messages:messages.slice(0,1)}),/完整|根/);assert.equal(calls,before);
 const grant=await restore(value);assert.equal(grant.roots.length,2);grant.assertCurrent();revoked=true;assert.throws(()=>grant.assertCurrent(),/失效/);
 assert.deepEqual(snapshot.events.slice(0,events.length),events);console.log('managed-full-roots-restore');
 }finally{await ctx.fiber.dispose()}
 `)
 const result=spawnSync(process.execPath,[script],{env:{...process.env,DSH_HOME:layout.dshHome,TELOA_PROJECT_ROOT:programRoot,TELOA_RUNTIME_ROOT:layout.runtimeRoot,TELOA_WORKSPACE_ROOT:layout.workspaceRoot},encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/managed-full-roots-restore/)
})
