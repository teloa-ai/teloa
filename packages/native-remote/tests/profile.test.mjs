import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {composeEntries,readPackage,shippedLayers} from '../../native-browser/tests/composition.mjs'

const directory=fileURLToPath(new URL('../',import.meta.url))
const deployment={host:'teloa-acceptance',node:'/opt/dsh/bin/node',helper:'/opt/dsh/lib/helper.js',helperHash:'a'.repeat(64),workspace:'/srv/teloa-acceptance'}
async function implementation(){
  const path=join(directory,'profile.mjs')
  assert.ok(existsSync(path),'必须提供可执行的独立 Headless profile 生成器')
  return import(pathToFileURL(path).href)
}

test('远端能力不能当作 Web 插件一键安装，也不改写 Web profile',()=>{
  const manifest=readPackage(directory)
  assert.equal(manifest.name,'@teloa/native-remote')
  assert.equal(manifest.dsh?.bundle,undefined)
})

test('生成的 Headless 组合使用一致远端文件、进程、沙箱与工作区',async()=>{
  const {createRemoteProfile}=await implementation()
  const profile=createRemoteProfile(deployment)
  assert.deepEqual(profile.manifest.dsh.profile.bundles,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless'])
  const warnings=[]
  const rows=composeEntries([...shippedLayers(),profile.patches],warning=>warnings.push(warning))
  assert.deepEqual(warnings,[])
  const row=id=>rows.find(value=>value.id===id)
  for(const id of ['fs-sandbox','subprocess','sandbox'])assert.equal(row(id).disabled,true)
  assert.equal(row('teloa-fs-ssh').name,'@deepseek-ai/dsh-fs-ssh')
  assert.equal(row('teloa-subprocess-ssh').name,'@deepseek-ai/dsh-subprocess-ssh')
  assert.equal(row('teloa-sandbox-ssh').name,'@deepseek-ai/dsh-sandbox-ssh')
  assert.deepEqual(row('teloa-ssh').config,deployment)
  assert.deepEqual(row('sandbox-policy').config,{mode:'workspace-write',workspaceRoot:'/srv/teloa-acceptance'})
  assert.deepEqual(row('approval').config,{policy:'never'})
  assert.equal(row('tools').config.mode,'native')
  assert.equal(row('ptc-runtime').disabled,true)
  assert.equal(row('workflow-ptc').disabled,true)
  assert.equal(row('tool-workflow').disabled,true)
  assert.equal(row('tool-ralph').disabled,true)
  assert.equal(row('session-telemetry-otel').config.mode,'DISABLED')
  assert.equal(row('permission').config.presets['danger-full-access'],undefined)
})

test('配置拒绝 Web 混装、shell 目标、相对路径、根目录和无效摘要',async()=>{
  const {createRemoteProfile}=await implementation()
  for(const bad of [
    {...deployment,bundles:['@deepseek-ai/dsh-web-app']},
    {...deployment,host:'host;touch /tmp/unsafe'},
    {...deployment,host:'-oProxyCommand=bad'},
    {...deployment,node:'node'},
    {...deployment,helper:'../helper.js'},
    {...deployment,workspace:'/'},
    {...deployment,helperHash:'abcd'},
    {...deployment,mode:'danger-full-access'},
    {...deployment,password:'must-not-be-accepted'},
    {...deployment,helper:'/srv/teloa-acceptance/bin/helper.js'},
    {...deployment,workspace:'/srv//teloa-acceptance',helper:'/srv/teloa-acceptance/bin/helper.js'},
    {...deployment,node:'/tmp/node'},
  ])assert.throws(()=>createRemoteProfile(bad))
  const safe=createRemoteProfile({...deployment,mode:'read-only'})
  assert.equal(safe.patches.find(row=>row.id==='sandbox-policy').config.mode,'read-only')
})

test('CLI 仅生成新 profile，重复目标拒绝且不覆盖原文件',async()=>{
  await implementation()
  const temp=mkdtempSync(join(tmpdir(),'teloa-remote-profile-'))
  try{
    const target=join(temp,'isolated-headless')
    const args=[join(directory,'bin.mjs'),'--directory',target]
    const run=()=>spawnSync(process.execPath,args,{input:JSON.stringify(deployment),encoding:'utf8'})
    const first=run()
    assert.equal(first.status,0,first.stderr)
    const source=readFileSync(join(target,'cordis.patch.yml'),'utf8')
    const rows=composeEntries([...shippedLayers(),JSON.parse(source)])
    assert.equal(rows.find(row=>row.id==='teloa-ssh').config.host,'teloa-acceptance')
    assert.equal(rows.find(row=>row.id==='sandbox-policy').config.workspaceRoot,'/srv/teloa-acceptance')
    assert.equal(run().status,1)
    assert.equal(readFileSync(join(target,'cordis.patch.yml'),'utf8'),source)
    assert.equal(JSON.parse(readFileSync(join(target,'package.json'),'utf8')).dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'),false)
  }finally{rmSync(temp,{recursive:true,force:true})}
})
