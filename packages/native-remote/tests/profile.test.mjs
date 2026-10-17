import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {spawn,spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {SshConnection} from '@deepseek-ai/dsh-ssh'
import {SshRpcPeer,SSH_PROTOCOL_VERSION} from '@deepseek-ai/dsh-ssh/protocol'
import {helloSchema,targetSchema,writeResultSchema} from '@deepseek-ai/dsh-ssh/schemas'
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
  assert.deepEqual(row('teloa-ssh').config,{host:'teloa-acceptance',launch:{kind:'node-script',node:'/opt/dsh/bin/node'},helper:'/opt/dsh/lib/helper.js',helperHash:'a'.repeat(64),workspace:'/srv/teloa-acceptance'})
  assert.deepEqual(row('sandbox-policy').config,{mode:'workspace-write',workspaceRoot:'/srv/teloa-acceptance'})
  assert.deepEqual(row('approval').config,{policy:'never'})
  assert.equal(row('tools').config.mode,'native')
  assert.equal(row('ptc-runtime').disabled,true)
  assert.equal(row('workflow-ptc').disabled,true)
  assert.equal(row('tool-workflow').disabled,true)
  assert.equal(row('tool-ralph'),undefined,'alpha3 已移除旧 Ralph 条目，不生成失配补丁')
  assert.equal(row('session-telemetry-otel').config.mode,'DISABLED')
  assert.equal(row('permission').config.presets['danger-full-access'],undefined)
})

test('旧部署坐标生成的配置通过固定 alpha3 官方 Config，不再缺少 launch',async()=>{
  const {createRemoteProfile}=await implementation()
  const profile=createRemoteProfile(deployment)
  const config=profile.patches.flatMap(row=>row.insert??[]).find(row=>row.id==='teloa-ssh').config
  const official=SshConnection.Config(config)
  assert.deepEqual(official.launch,{kind:'node-script',node:'/opt/dsh/bin/node'})
  assert.equal(official.node,undefined)
  assert.equal(official.requestTimeoutMs,30000)
})

test('显式 executable 和 node-script 部署均通过官方 Config，保持原路径与安全组合',async()=>{
  const {createRemoteProfile}=await implementation()
  const {node,...base}=deployment
  for(const launch of [
    {kind:'executable'},
    {kind:'node-script',node},
    {kind:'node-script',node,bootstrapPath:'/opt/dsh/lib/ptc-worker.js',bootstrapHash:'b'.repeat(64)},
  ]){
    const input={...base,launch,mode:'read-only'},before=structuredClone(input)
    const profile=createRemoteProfile(input)
    const config=profile.patches.flatMap(row=>row.insert??[]).find(row=>row.id==='teloa-ssh').config
    assert.deepEqual(SshConnection.Config(config).launch,launch)
    assert.equal(config.node,undefined)
    assert.deepEqual(input,before,'生成器不修改原部署坐标')
    const rows=composeEntries([...shippedLayers(),profile.patches])
    assert.deepEqual(rows.find(row=>row.id==='approval').config,{policy:'never'})
    assert.equal(rows.find(row=>row.id==='sandbox-policy').config.mode,'read-only')
    for(const id of ['ptc-runtime','workflow-ptc','tool-workflow'])assert.equal(rows.find(row=>row.id===id).disabled,true,'部署 bootstrap 不自动授予 PTC')
    assert.equal(rows.find(row=>row.id==='tool-ralph'),undefined)
  }
})

test('launch 拒绝歧义、额外参数、凭据、未配对 bootstrap 和不可信部署路径',async()=>{
  const {createRemoteProfile}=await implementation()
  const {node,...base}=deployment
  assert.throws(()=>createRemoteProfile({...deployment,launch:{kind:'node-script',node}}),'旧 node 与新 launch 不能同时选择')
  for(const launch of [
    null,[],{kind:'other'},{kind:'executable',node},{kind:'executable',args:['--eval','unsafe']},
    {kind:'node-script'},{kind:'node-script',node:'node'},
    {kind:'node-script',node:'/tmp/node'},{kind:'node-script',node:'/srv/teloa-acceptance/node'},
    {kind:'node-script',node,password:'private'},
    {kind:'node-script',node,bootstrapPath:'/opt/dsh/worker.js'},
    {kind:'node-script',node,bootstrapHash:'b'.repeat(64)},
    {kind:'node-script',node,bootstrapPath:'/opt/dsh/worker.js',bootstrapHash:'INVALID'},
    {kind:'node-script',node,bootstrapPath:'/tmp/worker.js',bootstrapHash:'b'.repeat(64)},
    {kind:'node-script',node,bootstrapPath:'/srv//teloa-acceptance/worker.js',bootstrapHash:'b'.repeat(64)},
    {kind:'node-script',node,bootstrapPath:'/opt/dsh/../worker.js',bootstrapHash:'b'.repeat(64)},
  ])assert.throws(()=>createRemoteProfile({...base,launch}),JSON.stringify(launch))
})

test('所有启动文件均拒绝 macOS 沙箱可写临时路径',async()=>{
  const {createRemoteProfile}=await implementation()
  const {node,...base}=deployment
  for(const root of ['/private/var/tmp','/var/folders/ab/test/T','/private/var/folders/ab/test/T']){
    assert.throws(()=>createRemoteProfile({...deployment,node:root+'/node'}),/临时目录/)
    assert.throws(()=>createRemoteProfile({...deployment,helper:root+'/helper.js'}),/临时目录/)
    assert.throws(()=>createRemoteProfile({...base,launch:{kind:'node-script',node,bootstrapPath:root+'/worker.js',bootstrapHash:'b'.repeat(64)}}),/临时目录/)
  }
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

test('生成坐标可供本机官方 helper 完成协议2握手与有界文件RPC（不建立SSH）',{timeout:30000},async t=>{
  const {createRemoteProfile}=await implementation()
  // 官方 workspace-write 同时允许平台临时目录；越界断言必须放在非临时目录的本轮自有资源。
  const temp=realpathSync(mkdtempSync(join(directory,'.test-helper-rpc-')))
  let close=async()=>{}
  t.after(async()=>{try{await close()}finally{rmSync(temp,{recursive:true,force:true})}})
  const workspace=join(temp,'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace,'input.txt'),'官方 helper 协议2\n')
  const helper=createRequire(import.meta.url).resolve('@deepseek-ai/dsh-ssh/helper')
  const helperHash=createHash('sha256').update(readFileSync(helper)).digest('hex')
  const profile=createRemoteProfile({host:'local-rpc-only',launch:{kind:'node-script',node:process.execPath},helper,helperHash,workspace})
  const config=SshConnection.Config(profile.patches.flatMap(row=>row.insert??[]).find(row=>row.id==='teloa-ssh').config)
  const env={...process.env};delete env.DSH_SSH_SANDBOX
  const child=spawn(config.launch.node,['--disable-sigusr1',config.helper],{cwd:workspace,env,stdio:['pipe','pipe','pipe']})
  const stderr=[];child.stderr.on('data',bytes=>stderr.push(bytes.toString()))
  const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)))
  const peer=new SshRpcPeer(child.stdout,child.stdin,config.maxFrameBytes,config.maxPending)
  const nullSchema={parse(value){assert.equal(value,null);return null}}
  close=async()=>{
    const kill=setTimeout(()=>child.kill('SIGKILL'),5000)
    try{
      await peer.request('close',{},nullSchema,AbortSignal.timeout(5000)).catch(()=>{})
      peer.close()
      assert.equal(await exited,0,stderr.join(''))
      assert.equal(stderr.join(''),'')
    }finally{clearTimeout(kill)}
  }
  const request=(method,params,schema)=>peer.request(method,params,schema,AbortSignal.timeout(5000))
  const hello=await request('hello',{protocol:SSH_PROTOCOL_VERSION,workspace:config.workspace,leaseMs:config.leaseMs},helloSchema)
  assert.equal(hello.protocol,2)
  assert.equal(hello.kind,'node-script')
  assert.equal(hello.hash,config.helperHash)
  assert.equal(hello.workspace,workspace)
  const input=await request('fs.resolve',{path:'input.txt'},targetSchema)
  const textSchema={parse(value){assert.equal(typeof value,'string');return value}}
  assert.equal(await request('fs.readText',{target:input},textSchema),'官方 helper 协议2\n')
  const output=await request('fs.resolve',{path:'result.txt'},targetSchema)
  const write={target:output,content:'原文件回执\n',expected:{kind:'createIfAbsent'}}
  await assert.rejects(request('fs.write',{...write,policy:{mode:'read-only',workspaceRoot:workspace}},writeResultSchema),error=>error.name==='RemoteOperationError')
  assert.equal(existsSync(join(workspace,'result.txt')),false)
  const written=await request('fs.write',{...write,policy:{mode:'workspace-write',workspaceRoot:workspace}},writeResultSchema)
  assert.equal(written.operation,'create')
  assert.equal(readFileSync(join(workspace,'result.txt'),'utf8'),'原文件回执\n')
  const outside=await request('fs.resolve',{path:join(temp,'outside.txt')},targetSchema)
  await assert.rejects(request('fs.write',{...write,target:outside,policy:{mode:'workspace-write',workspaceRoot:workspace}},writeResultSchema),error=>error.name==='RemoteOperationError')
  assert.equal(existsSync(join(temp,'outside.txt')),false)
})
