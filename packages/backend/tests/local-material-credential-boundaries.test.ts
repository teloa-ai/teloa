import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {writeFileSync,unlinkSync,symlinkSync} from 'node:fs'
import {mkdtemp,writeFile,rm,realpath,lstat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Client,Pool} from 'pg'
import {AuthorizedLocalMaterialCatalog} from '../src/capabilities/authorized-local-material-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {guardDecision,protectedRootsFor} from '../../harness-dsh/src/credential-guards.ts'

// 只替代 SQL 传输；真实资料服务、读取器、凭据守卫和文件系统都参与，不启动数据库。
test('逐资料前后核验保留本人/范围/撤回、正文改版、读取期撤权及链接替换拒绝',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-local-guard-boundaries-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const file=join(root,'material.md'),other=join(root,'other.md'),text='# 本轮合成资料\n'
 await writeFile(file,text);await writeFile(other,'# 不得沿替换链接读取\n')
 const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),state=await lstat(root,{bigint:true}),owner=randomUUID(),sourceId=randomUUID(),resourceId=randomUUID(),now=new Date()
 const actor={ownerId:owner,kind:'human' as const,scopeIds:['general']},expected={resourceId,resourceVersion:1,sourceVersion:sha(text)}
 const material={id:sourceId,owner_id:owner,title:'合成资料',relative_path:'material.md',scope_ids:['general'],workspace_root:root,workspace_key:sha(root+'\0'+state.dev+'\0'+state.ino)}
 const resource={id:resourceId,owner_id:owner,revision:1,status:'active',spec:{title:'合成资料',sourceId:'local_material_'+sourceId,sourceVersion:sha(text),scopeIds:['general']},created_at:now,updated_at:now}
 const pool=new Pool(),client=Object.assign(new Client(),{release(){}})
 t.after(()=>pool.end())
 t.mock.method(client,'query',async(sql:unknown,values?:unknown[])=>{
  let rows:unknown[]
  if(sql==='select * from teloa_resources where id=$1 for share')rows=values?.[0]===resourceId?[resource]:[]
  else if(sql==='select * from teloa_authorized_local_materials where owner_id=$1 and id=$2')rows=values?.[0]===owner&&values[1]===sourceId?[material]:[]
  else throw Error('未预期的 SQL；本例不能写数据库')
  return {rows,command:'SELECT',rowCount:rows.length,oid:0,fields:[]}
 })
 let permitted=true,checks=0,onCheck:(()=>void)|undefined,protectFile=false
 const catalog=new AuthorizedLocalMaterialCatalog(pool,{id:randomUUID,now:()=>now.toISOString()},{authorize:async(principal,scopes)=>{
  assert.equal(principal.ownerId,owner);assert.deepEqual(scopes,['general'])
  return {workspaceRoot:root,assertCurrent(){assert.ok(permitted)},isProtectedPath(path){
   checks++;if(checks===3)onCheck?.()
   return guardDecision({file_path:path},{toolName:'read',cwd:root,roots:protectedRootsFor({providerPaths:protectFile?[file]:[],runtimeRoot:join(root,'runtime'),env:{}}),known:[],env:{},home:root})!==undefined
  }}
 }})
 const service=new ResourceService(pool,catalog,{id:randomUUID,now:()=>now.toISOString()}),current=(principal=actor)=>service.isRetrievalSourceCurrentInTransaction(client,principal,expected)
 assert.equal(await current(),true);assert.equal(checks,3,'初始、打开前、读取后的三个动态凭据检测均保留')
 checks=0;await assert.rejects(current({...actor,ownerId:'00000000-0000-4000-8000-000000000099'}),{code:'teloa/forbidden'});assert.equal(checks,0)
 await assert.rejects(current({...actor,scopeIds:['other']}),{code:'teloa/forbidden'});assert.equal(checks,0)
 resource.status='withdrawn';assert.equal(await current(),false);assert.equal(checks,0);resource.status='active'
 await assert.rejects(service.isRetrievalSourceCurrentInTransaction(client,actor,{...expected,resourceId:randomUUID()}),{code:'teloa/not-found'})
 await writeFile(file,'# 新正文版本\n');assert.equal(await current(),false,'SHA 不符不能沿用旧索引版本');await writeFile(file,text)
 checks=0;onCheck=()=>writeFileSync(file,'# 读取期间修改\n');assert.equal(await current(),false,'最终边界后的文件变化仍由原 inode/mtime/ctime/SHA 校验发现');await writeFile(file,text)
 checks=0;onCheck=()=>{permitted=false};await assert.rejects(current(),{code:'teloa/forbidden'});permitted=true
 checks=0;onCheck=()=>{protectFile=true};await assert.rejects(current(),{code:'teloa/forbidden'});protectFile=false
 checks=0;onCheck=()=>{unlinkSync(file);symlinkSync(other,file)};await assert.rejects(current(),{code:'teloa/forbidden'})
 unlinkSync(file);await writeFile(file,text);checks=0;onCheck=undefined
 assert.equal(await current(),true);assert.equal(checks,3)
})
