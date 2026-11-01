import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {apply} from '../src/index.ts'
import {host} from './fixtures/production-host.ts'
import {unwrapWorkRpcResult} from '../../client/ui-workbench/src/client/work-rpc-result.ts'

test('输入建议正式 RPC 使用客户端可读的统一回包，无事实不调用模型',{timeout:120000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-suggestion-rpc-')),runtime=host(),previousRoot=process.env.TELOA_PROJECT_ROOT
 let container:StartedPostgreSqlContainer|undefined
 t.after(async()=>{t.diagnostic('suggestion-rpc cleanup:start');await runtime.ctx.fiber.dispose();t.diagnostic('suggestion-rpc cleanup:context');await container?.stop();if(previousRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousRoot;await rm(root,{recursive:true,force:true})})
 process.env.TELOA_PROJECT_ROOT=process.cwd()
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true})
 await writeFile(join(root,'.runtime/teloa/database.json'),JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true})
 await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 t.diagnostic('suggestion-rpc ready:start');await runtime.ready(join(root,'.runtime/dsh'));t.diagnostic('suggestion-rpc ready:done');await apply(runtime.ctx,{projectRoot:root});t.diagnostic('suggestion-rpc apply:done')
 const reply=await runtime.rpc('composer-suggestion/read',{sessionId:randomUUID()},AbortSignal.timeout(5000))
 t.diagnostic('suggestion-rpc reply:received')
 assert.deepEqual(reply,{ok:true,value:{text:null}})
 assert.deepEqual(unwrapWorkRpcResult(reply as {ok:true;value:{text:null}}),{text:null})
 assert.deepEqual(runtime.modelCalls,[])
})
