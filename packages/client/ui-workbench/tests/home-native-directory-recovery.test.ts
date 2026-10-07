import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as homeNative from '../src/client/home-native-controller.ts'
import {ConversationService,type StoredConversation} from '../../../backend/src/work/conversations.ts'

/** 执行真实注册代码里的 create 端口，服务端使用真实会话校验和领养逻辑。 */
function createPort(ports:Record<string,unknown>){
 const source=readFileSync(new URL('../src/client/index.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true)
 let create:ts.Expression|undefined
 const visit=(node:ts.Node)=>{
  if(ts.isNewExpression(node)&&node.expression.getText(ast)==='HomeNativeController'){
   const options=node.arguments?.[0]
   if(options&&ts.isObjectLiteralExpression(options))for(const property of options.properties)if(ts.isPropertyAssignment(property)&&property.name.getText(ast)==='create')create=property.initializer
  }
  ts.forEachChild(node,visit)
 }
 visit(ast);assert.ok(create)
 const js=ts.transpileModule('const create='+create.getText(ast)+';return create',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const input={...ports,homeNativeAdoptionRequestId:(homeNative as any).homeNativeAdoptionRequestId}
 return new Function(...Object.keys(input),js)(...Object.values(input)) as (id:string)=>Promise<string>
}

function fixture(sessionId:string,lost=false){
 const saved=new Map<string,string>(),storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value)},removeItem:(key:string)=>{saved.delete(key)}}
 let rows:StoredConversation[]=[],counter=0
 const created:string[]=[],requests:any[]=[]
 const service=new ConversationService({read:async()=>rows,write:async value=>{rows=value}}, {create:async id=>{created.push(id);return id},inspect:async id=>{assert.equal(id,sessionId)}},{id:()=>`binding-${++counter}`,now:()=> '2026-10-07T12:00:00.000Z'})
 const sessions={list:{getSnapshot:()=>({byId:{[sessionId]:{title:'原来的工作'}}})},create:async({sessionId:id}:any)=>{created.push(id);return id}}
 const ports={requireWorkContext:()=>({sessions}),brandString:(value:string)=>value,mainSession:{getSnapshot:()=>sessionId},management:{getSnapshot:()=>({workspaces:[]})},navigationStorage:storage,isConversation:(value:any)=>value?.sessionId===sessionId,work:{refreshDirectory:async()=>{}},call:async(endpoint:string,input:any)=>{
  assert.equal(endpoint,'conversations/adopt');requests.push(input)
  const value=await service.adopt('local:owner',input)
  if(lost){lost=false;throw Error('network response lost')}
  return value
 }}
 return {storage,ports,created,requests,rows:()=>rows}
}

test('设置返回冷恢复官方 session- 会话：恢复原会话，不创建会话或要求选择目录',async()=>{
 const id='session-12345678-1234-4234-8234-123456789012',f=fixture(id)
 f.storage.setItem('teloa.home-native-session/v1',id)
 const controller=new homeNative.HomeNativeController({storage:f.storage,identity:()=>{throw Error('不应换新草稿')},isBlank:()=>true,create:createPort(f.ports)})
 assert.equal(await controller.prepare(),id)
 assert.equal(controller.owns(id),true);assert.deepEqual(f.created,[])
 assert.equal(f.rows().length,1);assert.match(f.requests[0].requestId,/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i)
})

test('冷恢复领养回包丢失：重试复用同一请求和原会话，不重建或重发任务',async()=>{
 const id='session-22345678-1234-4234-8234-123456789012',f=fixture(id,true)
 f.storage.setItem('teloa.home-native-session/v1',id)
 const controller=()=>new homeNative.HomeNativeController({storage:f.storage,identity:()=>{throw Error('不应换新草稿')},isBlank:()=>true,create:createPort(f.ports)})
 await assert.rejects(controller().prepare(),/network response lost/)
 assert.equal(f.storage.getItem('teloa.home-native-session/v1'),id)
 assert.equal(await controller().prepare(),id)
 assert.equal(f.requests.length,2);assert.equal(f.requests[0].requestId,f.requests[1].requestId)
 assert.equal(f.rows().length,1);assert.deepEqual(f.created,[])
})

test('旧版 UUID 待用会话保留原请求身份，冷恢复不改写已发放绑定',async()=>{
 const id='32345678-1234-4234-8234-123456789012',f=fixture(id)
 await createPort(f.ports)(id)
 assert.equal(f.requests[0].requestId,id);assert.equal(f.rows().length,1);assert.deepEqual(f.created,[])
})
