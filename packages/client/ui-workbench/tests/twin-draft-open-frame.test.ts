import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import ts from 'typescript'
import type {Conversation} from '@teloa/contract'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'

const hooks=registerHooks({resolve(specifier,context,next){return next(specifier==='./blank-conversation-draft.js'?'./blank-conversation-draft.ts':specifier,context)}})
const {openTwinDraftConversation}=await import('../src/client/twin-draft-conversation.ts')
const {pageCreateDraftRevisionNavigation}=await import('../src/client/page-create-revision-context.ts')
hooks.deregister()
const file=ts.createSourceFile('WorkbenchFrame.tsx',readFileSync(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
let initializer:ts.Expression|undefined
function find(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='openSavedTwinDraft')initializer=node.initializer;else ts.forEachChild(node,find)}
find(file);assert.ok(initializer)
const code=ts.transpileModule('const openSavedTwinDraft='+initializer.getText(file),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
async function fixture(at:'read'|'adopt'){
 const wait=deferred(),writes:string[]=[],opened:string[]=[],actionsLog:string[]=[],reads:string[]=[],original={},currentTwinDraftApi={current:original}
 let selected=true,current='previous',draft=''
 const row=(sessionId:string):Conversation=>({id:'conversation-'+sessionId,sessionId,requestedSessionId:sessionId,scopeIds:['general'],ownerId:'owner',status:'ready',version:1,title:sessionId,createdAt:'2026-10-21T00:00:00Z'})
 const port={current:()=>current,ensure:async(id:string)=>row(id),read:async(id:string)=>{reads.push(id);if(at==='read')await wait.promise;return row(id)},adopt:async(id:string)=>{if(at==='adopt')await wait.promise;return id},isNativeChild:()=>false,block:()=>{},open:(id:string)=>{opened.push(id);current=id},list:async()=>[]} as unknown as WorkPort
 const work=new BindingClient(port);await work.select('previous')
 const env={twinDraftApi:original,currentTwinDraftApi,projectFrameMounted:{current:true},beginNativeNavigation:()=>undefined,pageCreateDraftRevisionNavigation,homeCreationLocation:()=> 'same-twin-workspace',latestState:{current:{}},mainSession:{getSnapshot:()=>current},work,openTwinDraftConversation,conversationDraftInput:()=>({state:{getSnapshot:()=>({draft,attachmentIds:[],occurrences:[],queue:[],phase:'plain'})},setDraft:(text:string)=>{writes.push(text);draft=text}}),twinDraftCopy:(_locale:string,key:string)=>key,locale:'zh-CN',actions:{closeDetail:()=>actionsLog.push('close'),openMessages:()=>actionsLog.push('navigate')},closeNarrowDirectory:()=>actionsLog.push('directory')}
 const run=new Function(...Object.keys(env),code+';return openSavedTwinDraft')(...Object.values(env)) as (id:string,text:string,current:()=>boolean)=>Promise<void>
 return {run:()=>run('original-A','A待发送正文',()=>selected),cancel:()=>{selected=false},wait,writes,opened,actionsLog,reads,work}
}
for(const at of ['read','adopt'] as const)test('Frame在真实BindingClient '+at+'慢回包期间切稿，不打开/回填/关闭后来的B',async()=>{
 const f=await fixture(at),pending=f.run();await new Promise<void>(r=>setImmediate(r));f.cancel();f.wait.resolve()
 await assert.rejects(pending,{code:'teloa/twin-draft-open-unavailable'})
 assert.deepEqual(f.opened,[]);assert.deepEqual(f.writes,[]);assert.deepEqual(f.actionsLog,[]);assert.equal(f.work.getSnapshot().sessionId,'previous')
})
test('Frame在已切稿时不发起原会话读取，原选择有效则一次回填但不发送',async()=>{
 const cancelled=await fixture('read');cancelled.cancel();cancelled.wait.resolve();await assert.rejects(cancelled.run(),{code:'teloa/twin-draft-open-unavailable'});assert.deepEqual(cancelled.reads,[])
 const current=await fixture('read'),pending=current.run();current.wait.resolve();await pending
 assert.deepEqual(current.opened,['original-A']);assert.deepEqual(current.writes,['A待发送正文']);assert.deepEqual(current.actionsLog,['close','navigate','directory'])
})
