import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {createGithubSourceHandler} from '../src/github-source.ts'
import {downloadGithubCatalogSkill,type GithubHttpPort,type GithubHttpRequest} from '../../backend/src/market/github-source.ts'
import type {MarketCatalogUpstreamGithub} from '@teloa/contract'

const requestId='11111111-1111-4111-8111-111111111111',commit='0123456789abcdef0123456789abcdef01234567',archiveHash='a'.repeat(64),bytes=new TextEncoder().encode('{}')
const request={requestId,owner:'teloa-ai',repo:'starter',ref:'main'}
const receipt={requestId,ownerId:'local:teloa-owner',stage:'ready' as const,provenance:{kind:'github' as const,owner:request.owner,repo:request.repo,requestedRef:request.ref,resolvedCommit:commit,archiveHash},files:[{path:'teloa.json',hash:createHash('sha256').update(bytes).digest('hex'),bytes}],createdAt:'2026-09-12T08:00:00.000Z',updatedAt:'2026-09-12T08:01:00.000Z'}

/** 执行宿主的真实 initializer 与响应流函数，避免复制一份恰好透传完整头的测试端口。 */
async function hostGithubHttp(fetcher:typeof fetch):Promise<GithubHttpPort>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),tree=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true)
 let initializer:ts.Expression|undefined,body:ts.FunctionDeclaration|undefined
 const visit=(node:ts.Node)=>{
  if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.name.text==='githubHttp')initializer=node.initializer
  if(ts.isFunctionDeclaration(node)&&node.name?.text==='githubResponseBody')body=node
  ts.forEachChild(node,visit)
 }
 visit(tree);assert.ok(initializer&&body,'宿主必须保留实际 GitHub HTTP 端口和流读取器')
 const code=ts.transpileModule(body.getText(tree)+'\nreturn ('+initializer.getText(tree)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 return new Function('fetch',code)(fetcher) as GithubHttpPort
}

test('真实GitHub适配器透传manual、signal、状态和必要响应头，逐字节读取且不外泄无关头',async()=>{
 const response=new Response('body',{status:403,headers:{'Content-Length':'4','Retry-After':'60',Location:'https://api.github.com/repositories/7/git/trees/'+commit,'Content-Disposition':`attachment; filename=renamed-${commit}.zip`,'X-RateLimit-Remaining':'0','X-RateLimit-Reset':'1234567890','X-RateLimit-Resource':'core','X-Unrelated':'not-forwarded','Set-Cookie':'not-forwarded'}})
 const calls:{input:Parameters<typeof fetch>[0];init:Parameters<typeof fetch>[1]}[]=[],adapter=await hostGithubHttp(async(input,init)=>{calls.push({input,init});return response})
 const controller=new AbortController(),headers={accept:'application/vnd.github+json','user-agent':'fixture'},input:GithubHttpRequest={url:'https://api.github.com/repos/example/repo/git/trees/'+commit,method:'GET',headers,redirect:'manual',signal:controller.signal}
 const result=await adapter.request(input)
 assert.equal(calls.length,1);assert.equal(calls[0]!.input,input.url);assert.equal(calls[0]!.init?.method,'GET');assert.equal(calls[0]!.init?.redirect,'manual');assert.equal(calls[0]!.init?.signal,controller.signal);assert.equal(calls[0]!.init?.headers,headers)
 assert.equal(result.status,403)
 assert.deepEqual(result.headers,{'content-length':'4','retry-after':'60',location:'https://api.github.com/repositories/7/git/trees/'+commit,'content-disposition':`attachment; filename=renamed-${commit}.zip`,'x-ratelimit-remaining':'0','x-ratelimit-reset':'1234567890','x-ratelimit-resource':'core'})
 const chunks:Uint8Array[]=[];for await(const chunk of result.body)chunks.push(chunk)
 assert.equal(Buffer.concat(chunks).toString(),'body');assert.equal(response.body!.locked,false)
})

function renamedArchive(root:string,files:Record<string,string>):Uint8Array{
 const entries=[{path:root+'/',text:''},{path:root+'/skills/',text:''},{path:root+'/skills/slack-messaging/',text:''},...Object.entries(files).map(([path,text])=>({path:root+'/'+path,text}))],locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0
 const crc32=(value:Uint8Array)=>{let crc=0xffffffff;for(const byte of value){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return (crc^0xffffffff)>>>0}
 for(const entry of entries){
  const name=Buffer.from(entry.path),plain=Buffer.from(entry.text),crc=crc32(plain),local=Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(10,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(plain.length,18);local.writeUInt32LE(plain.length,22);local.writeUInt16LE(name.length,26);locals.push(local,name,plain)
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(10,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(plain.length,20);central.writeUInt32LE(plain.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(entry.path.endsWith('/')?16:0,38);central.writeUInt32LE(offset,42);centrals.push(central,name);offset+=30+name.length+plain.length
 }
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centrals.reduce((sum,part)=>sum+part.length,0),12);end.writeUInt32LE(offset,16);end.writeUInt16LE(commit.length,20)
 return Buffer.concat([...locals,...centrals,end,Buffer.from(commit)])
}

test('真实宿主端口接后端：限额后同提交规范更名ZIP可核对技能与许可，错误响应文件名仍拒绝',async()=>{
 const files={'skills/slack-messaging/SKILL.md':'---\nname: adapter-fixture\ndescription: Notes\n---\n# Notes\n',LICENSE:'MIT License\n'},hash=(value:string)=>createHash('sha256').update(value).digest('hex'),blob=(value:string)=>createHash('sha1').update('blob '+Buffer.byteLength(value)+'\0').update(value).digest('hex')
 const source:MarketCatalogUpstreamGithub={kind:'github',repository:{host:'github.com',owner:'slackapi',repo:'slack-mcp-plugin'},commit,path:'skills/slack-messaging',files:Object.entries(files).map(([path,text])=>({path:path==='LICENSE'?'licenses/upstream/LICENSE':'SKILL.md',...(path==='LICENSE'?{repositoryPath:'LICENSE'}:{}),size:Buffer.byteLength(text),gitBlob:blob(text),sha256:hash(text)}))}
 const canonical='slack-skills-plugin-'+commit,zip=renamedArchive(canonical,files)
 for(const correct of [true,false]){
  const calls:{url:string;redirect:RequestRedirect|undefined}[]=[],adapter=await hostGithubHttp(async(input,init)=>{
   const url=String(input);calls.push({url,redirect:init?.redirect});assert.ok(init?.signal)
   if(url===`https://api.github.com/repos/slackapi/slack-mcp-plugin/git/trees/${commit}`)return new Response('rate limited',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'1792591889'}})
   assert.equal(url,`https://codeload.github.com/slackapi/slack-mcp-plugin/zip/${commit}`)
   return new Response(Uint8Array.from(zip).buffer,{status:200,headers:{'content-length':String(zip.length),'content-disposition':`attachment; filename=${correct?canonical:'slack-skills-plugin-'+'b'.repeat(40)}.zip`}})
  })
  if(correct){const downloaded=await downloadGithubCatalogSkill(source,adapter);assert.deepEqual(downloaded.map(file=>[file.path,Buffer.from(file.bytes).toString()]),[['SKILL.md',files['skills/slack-messaging/SKILL.md']],['licenses/upstream/LICENSE',files.LICENSE]])}
  else await assert.rejects(downloadGithubCatalogSkill(source,adapter),(error:unknown)=>error instanceof Error&&/API 限流/.test(error.message)&&/归档响应文件名/.test(error.message))
  assert.equal(calls.length,2);assert.ok(calls.every(row=>row.redirect==='manual'))
 }
})

test('固定认证本人调用服务，并将字节编码为严格工作台回包',async()=>{
 const calls:unknown[][]=[],handler=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async(owner,input)=>{calls.push([owner,input]);return receipt}}))
 assert.deepEqual(await handler('market/github/resolve',request),{...receipt,ownerId:'self',files:[{path:'teloa.json',hash:receipt.files[0]!.hash,base64:'e30='}]})
 assert.deepEqual(calls,[['local:teloa-owner',request]])
})

test('未知字段和错误宿主回包在边界拒绝',async()=>{
 let calls=0
 const handler=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>{calls++;return receipt}}))
 await assert.rejects(handler('market/github/resolve',{...request,url:'https://github.com/teloa-ai/starter'}),{code:'teloa/invalid-input'});assert.equal(calls,0)
 const make=(value:unknown)=>createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>value}))
 await assert.rejects(make({...receipt,ownerId:'other'})('market/github/resolve',request),{code:'teloa/invalid-host-response'})
 await assert.rejects(make({...receipt,files:[{...receipt.files[0],hash:'b'.repeat(64)}]})('market/github/resolve',request),{code:'teloa/invalid-host-response'})
})

test('宿主入口初始化数据库并注册固定来源 RPC',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(source,/await initializeTeloaDatabase\(database\.pool[,)]/)
 assert.match(sequence,/await initializeGithubSources\(pool\)/)
 assert.match(source,/\.\.\.githubSourceEndpoints/)
 assert.match(source,/githubSourceHandler\(endpoint,payload\)/)
})

test('子目录请求透传 path，回包的 path 必须与请求一致',async()=>{
 const withPath={...request,path:'skills/pdf'},calls:unknown[]=[]
 const good=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async(_owner,input)=>{calls.push(input);return {...receipt,provenance:{...receipt.provenance,path:'skills/pdf'}}}}))
 const result=await good('market/github/resolve',withPath) as {provenance:{path?:string}}
 assert.equal(result.provenance.path,'skills/pdf');assert.deepEqual(calls,[withPath])
 const drifted=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>({...receipt,provenance:{...receipt.provenance,path:'skills/other'}})}))
 await assert.rejects(drifted('market/github/resolve',withPath),{code:'teloa/invalid-host-response'})
 const missing=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>receipt}))
 await assert.rejects(missing('market/github/resolve',withPath),{code:'teloa/invalid-host-response'})
 const extra=createGithubSourceHandler('local:teloa-owner',async()=>({resolve:async()=>({...receipt,provenance:{...receipt.provenance,path:'x'}})}))
 await assert.rejects(extra('market/github/resolve',request),{code:'teloa/invalid-host-response'})
 for(const path of ['../x','/x','x/','a//b'])await assert.rejects(good('market/github/resolve',{...request,path}),{code:'teloa/invalid-input'})
})
