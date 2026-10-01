import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm,realpath} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,delimiter} from 'node:path'

// Docker 和数据库是外部依赖；执行真实安装入口，隔离到临时工程。
async function runSetup(mode){
  const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-docker-setup-')))
  try{
    await mkdir(join(root,'scripts'))
    await mkdir(join(root,'bin'))
    await copyFile(new URL('../scripts/准备资料数据库.mjs',import.meta.url),join(root,'scripts/准备资料数据库.mjs'))
    await writeFile(join(root,'scripts/初始化资料数据库.mjs'),`import {readFile,writeFile} from 'node:fs/promises';
export async function waitForTeloaDatabase(path){JSON.parse(await readFile(path,'utf8'))}
export async function initializeTeloaDatabase(path){await writeFile(path+'.initialized','yes')}`)
    const docker=join(root,'bin/docker')
    await writeFile(docker,`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),root=process.env.SETUP_TEST_ROOT,mode=process.env.SETUP_TEST_MODE;
fs.appendFileSync(root+'/calls.jsonl',JSON.stringify({args,context:process.env.DOCKER_CONTEXT})+'\\n');
const fail=message=>{console.error(message);process.exit(1)};
if(args.includes('--context'))fail('The test engine has no vendor context');
if(mode==='offline')fail('Cannot connect to Docker daemon');
if(args[0]==='info')process.exit(0);
if(args[0]==='inspect'){
 if(mode==='new'&&!fs.existsSync(root+'/created'))fail('No such object: teloa-postgres');
 if(mode==='inspect-error')fail('permission denied');
 console.log(JSON.stringify([{Config:{Labels:{'teloa.project':mode==='foreign'?'different-project':root+'/'}},State:{Running:mode!=='stopped'||fs.existsSync(root+'/started')},NetworkSettings:{Ports:{'5432/tcp':[{HostPort:'45432'}]}}}]));
}else if(args[0]==='volume'&&args[1]==='inspect')fail('No such volume: teloa-postgres-data');
else if(args[0]==='run')fs.writeFileSync(root+'/created','yes');
else if(args[0]==='start')fs.writeFileSync(root+'/started','yes');
`,{mode:0o755})
    if(['existing','stopped','foreign','inspect-error'].includes(mode)){
      await mkdir(join(root,'.runtime/teloa'),{recursive:true})
      await writeFile(join(root,'.runtime/teloa/postgres.env'),'POSTGRES_PASSWORD=fixture-password\n')
    }
    const result=spawnSync(process.execPath,[join(root,'scripts/准备资料数据库.mjs')],{encoding:'utf8',env:{...process.env,PATH:join(root,'bin')+delimiter+process.env.PATH,DOCKER_CONTEXT:'desktop-linux',SETUP_TEST_ROOT:root,SETUP_TEST_MODE:mode}})
    const calls=(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
    let config,initialized=false
    try{config=JSON.parse(await readFile(join(root,'.runtime/teloa/database.json'),'utf8'));initialized=await readFile(join(root,'.runtime/teloa/database.json.initialized'),'utf8')==='yes'}catch{}
    return {...result,calls,config,initialized}
  }finally{await rm(root,{recursive:true,force:true})}
}

test('标准 Docker 环境可从空工程准备数据库并初始化',async()=>{
  const r=await runSetup('new')
  assert.equal(r.status,0,r.stderr)
  assert.equal(r.initialized,true)
  assert.match(r.config.connectionString,/@127\.0\.0\.1:45432\/teloa$/)
  assert.equal(r.calls.every(call=>call.context==='desktop-linux'),true)
  const run=r.calls.find(call=>call.args[0]==='run').args
  assert.equal(run[run.indexOf('--publish')+1],'127.0.0.1::5432')
  assert.equal(r.stdout.includes('fixture-password'),false)
})
test('复用属于本工程的数据库，不重复创建容器',async()=>{
  const r=await runSetup('existing')
  assert.equal(r.status,0,r.stderr)
  assert.equal(r.initialized,true)
  assert.equal(r.calls.some(call=>['run','start'].includes(call.args[0])),false)
})
test('停止的已有数据库可重新启动',async()=>{
  const r=await runSetup('stopped')
  assert.equal(r.status,0,r.stderr)
  assert.equal(r.calls.filter(call=>call.args[0]==='start').length,1)
})
test('Docker 不可用时报告前置条件，不创建卷或容器',async()=>{
  const r=await runSetup('offline')
  assert.equal(r.status,1)
  assert.match(r.stderr,/docker info/)
  assert.equal(r.calls.some(call=>['run','volume'].includes(call.args[0])),false)
  assert.equal(r.config,undefined)
})
test('同名外部容器不被接管或重建',async()=>{
  const r=await runSetup('foreign')
  assert.equal(r.status,1)
  assert.match(r.stderr,/不属于当前 Teloa 项目/)
  assert.equal(r.calls.some(call=>['run','start','volume'].includes(call.args[0])),false)
})
test('inspect 权限错误不能误当成容器不存在',async()=>{
  const r=await runSetup('inspect-error')
  assert.equal(r.status,1)
  assert.equal(r.calls.some(call=>['run','volume'].includes(call.args[0])),false)
})
