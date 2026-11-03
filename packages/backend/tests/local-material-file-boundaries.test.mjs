import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,lstat,rm,realpath} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {AuthorizedLocalMaterialCatalog} from '../src/capabilities/authorized-local-material-catalog.ts'
test('宿主guard元数据来自真实登记并核owner/root身份，不读取任何原件正文',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-file-boundaries-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const state=await lstat(root,{bigint:true}),key=createHash('sha256').update(root+'\0'+state.dev+'\0'+state.ino).digest('hex')
 let revoked=false,queries=0,row={id:'11111111-1111-4111-8111-111111111111',owner_id:'owner',title:'protected',relative_path:'missing.md',scope_ids:['SOC'],workspace_root:root,workspace_key:key}
 const pool={query:async(sql,args)=>{queries++;assert(sql.includes('owner_id=$1 and workspace_root=$2'));assert.deepEqual(args,['owner',root]);return{rows:[row]}}}
 const catalog=new AuthorizedLocalMaterialCatalog(pool,{id:()=>'',now:()=>''},{authorize:async()=>({workspaceRoot:root,assertCurrent:()=>{assert(!revoked)},isProtectedPath:()=>false})})
 const actor={ownerId:'owner',kind:'human',scopeIds:['general','AppSec','SOC']}
 assert.deepEqual(await catalog.fileBoundaries(actor),[{path:join(root,'missing.md'),scopeIds:['SOC']}],'登记原件不存在仍不读取/丢失其范围边界')
 row={...row,owner_id:'foreign'};await assert.rejects(catalog.fileBoundaries(actor));row={...row,owner_id:'owner',workspace_key:'a'.repeat(64)};await assert.rejects(catalog.fileBoundaries(actor))
 revoked=true;await assert.rejects(catalog.fileBoundaries(actor));const before=queries;await assert.rejects(catalog.fileBoundaries({...actor,kind:'agent'}));assert.equal(queries,before,'模型主体不能直接枚举跨业务边界')
})
