import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm,stat,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {appendJsonl,createJsonStore} from '../src/core/store.ts'

type Counter={count:number}
const parseCounter=(value:unknown):Counter=>{
 if(typeof value!=='object'||value===null||typeof (value as {count?:unknown}).count!=='number')throw new Error('bad shape')
 return {count:(value as {count:number}).count}
}

async function withTemp(run:(root:string)=>Promise<void>):Promise<void>{
 const root=await mkdtemp(join(tmpdir(),'teloa-im-store-'))
 try{await run(root)}finally{await rm(root,{recursive:true,force:true})}
}

test('文件不存在时 read 返回 empty；写后目录 0o700、文件 0o600',()=>withTemp(async root=>{
 const path=join(root,'im','state.json')
 const store=createJsonStore(path,parseCounter,{count:0})
 assert.deepEqual(await store.read(),{count:0})
 await store.write({count:3})
 assert.deepEqual(await store.read(),{count:3})
 assert.equal((await stat(join(root,'im'))).mode&0o777,0o700)
 assert.equal((await stat(path)).mode&0o777,0o600)
}))

test('损坏 JSON → WorkError teloa/storage-corrupt',()=>withTemp(async root=>{
 const path=join(root,'bad.json')
 await writeFile(path,'{not json',{mode:0o600})
 const store=createJsonStore(path,parseCounter,{count:0})
 await assert.rejects(store.read(),(error:unknown)=>(error as {code?:unknown}).code==='teloa/storage-corrupt')
}))

test('形状不合法 → WorkError teloa/storage-corrupt',()=>withTemp(async root=>{
 const path=join(root,'shape.json')
 await writeFile(path,'{"count":"x"}',{mode:0o600})
 const store=createJsonStore(path,parseCounter,{count:0})
 await assert.rejects(store.update(current=>current),(error:unknown)=>(error as {code?:unknown}).code==='teloa/storage-corrupt')
}))

test('并发 update 10 次计数为 10',()=>withTemp(async root=>{
 const path=join(root,'counter.json')
 const store=createJsonStore(path,parseCounter,{count:0})
 await Promise.all(Array.from({length:10},()=>store.update(async current=>{await new Promise(resolve=>setTimeout(resolve,1));return {count:current.count+1}})))
 assert.deepEqual(await store.read(),{count:10})
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{count:10})
}))

test('update 回调抛错不阻塞后续写入',()=>withTemp(async root=>{
 const store=createJsonStore(join(root,'c.json'),parseCounter,{count:0})
 await assert.rejects(store.update(()=>{throw new Error('boom')}))
 assert.deepEqual(await store.update(current=>({count:current.count+1})),{count:1})
}))

test('appendJsonl 追加两行可逐行 JSON.parse，文件 0o600',()=>withTemp(async root=>{
 await mkdir(root,{recursive:true})
 const path=join(root,'audit','im-audit.jsonl')
 await appendJsonl(path,{kind:'a',n:1})
 await appendJsonl(path,{kind:'b',n:2})
 const lines=(await readFile(path,'utf8')).trimEnd().split('\n')
 assert.equal(lines.length,2)
 assert.deepEqual(lines.map(line=>JSON.parse(line)),[{kind:'a',n:1},{kind:'b',n:2}])
 assert.equal((await stat(path)).mode&0o777,0o600)
 assert.equal((await stat(join(root,'audit'))).mode&0o777,0o700)
}))
