import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadNativeInputProviders,composeNativeInput} from '../src/native-input-composition.ts'
import {applyPatches,communityRows,compatibilityAPIs,findRow} from './fixtures/native-input-composition.ts'

test('现有原生组合只替换外部提供方认证入口，原工具和权限配置保留',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-platform-compose-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const rows=[...communityRows(),{id:'subagent-codex',name:'@deepseek-ai/dsh-subagent-codex',config:{permissionMode:'never',env:{SAFE:'unchanged'}}},{id:'subagent-claude-code',name:'@deepseek-ai/dsh-subagent-claude-code',config:{permissionMode:'dontAsk'}}]
 const providers=await loadNativeInputProviders({compatibilityAPIs:compatibilityAPIs()})
 const composed=applyPatches(rows,await composeNativeInput(rows,{providers,runtimeRoot:root}))
 assert.equal(findRow(composed,'subagent-codex')?.disabled,true)
 const codex=findRow(composed,'teloa-platform-native-codex')!
 assert.equal(codex.name,'@teloa/harness-dsh/platform-native-provider')
 assert.deepEqual(codex.config,{engine:'codex',native:{permissionMode:'never',env:{SAFE:'unchanged'}}})
 assert.equal(findRow(composed,'teloa-platform-models')?.name,'@teloa/harness-dsh/platform-models')
 assert.equal(findRow(composed,'teloa-platform-native-claude-code')?.name,'@teloa/harness-dsh/platform-native-provider')
})
