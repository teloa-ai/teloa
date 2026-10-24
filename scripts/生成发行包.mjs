#!/usr/bin/env node
// 生成 @teloa/cli 的可发布包：结构与 0.2.8 已发布包一致（bin/packages/scripts/config/清单）。
// 用法：node scripts/生成发行包.mjs <version> <outDir>
import {createHash} from 'node:crypto'
import {cp,mkdir,readFile,readdir,rename,stat,writeFile} from 'node:fs/promises'
import {dirname,join,relative} from 'node:path'
import {execFileSync} from 'node:child_process'

const [version,outDir='artifacts/release']=process.argv.slice(2)
if(!/^\d+\.\d+\.\d+$/.test(version??''))throw Error('需要语义化版本号，例如 0.2.9')
const root=process.cwd(),stage=join(outDir,'package')
// DSH 版本取自固定基线（tag 形如 dsh-v0.2.1-rc.2）；清单里该字段是必填。
const baseline=JSON.parse(await readFile('config/dsh-baseline.json','utf8'))
const dshVersion=String(baseline.tag??'').replace(/^dsh-v/,'')
if(!dshVersion)throw Error('无法从 config/dsh-baseline.json 解析 DSH 版本')

await mkdir(stage,{recursive:true})
const copy=async(from,to=from)=>{await mkdir(dirname(join(stage,to)),{recursive:true});await cp(from,join(stage,to),{recursive:true})}
for(const file of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','TRADEMARK.md','README.md'])await copy(file)
await copy('third-party-licenses')
await copy('config')
for(const file of ['scripts/runtime','scripts/核对DSH依赖.mjs','scripts/核对宿主就绪.mjs'])await copy(file)
await mkdir(join(stage,'bin'),{recursive:true})
await writeFile(join(stage,'bin/teloa.js'),`#!/usr/bin/env node
import {main} from '../packages/cli/lib/bin.js'
import {redactLog} from '../packages/cli/lib/diagnostics.js'
main().catch(error=>{console.error(redactLog(error.message));process.exitCode=error.exitCode??1})
`)
// 各包：清单 + 构建产物 + 兼容补丁 + 预设 + 许可证
const packageDirs=[]
for(const group of ['packages']){
  for(const name of await readdir(group)){
    const dir=join(group,name)
    if(name==='client'){for(const client of await readdir(dir)){const d=join(dir,client);if((await stat(d)).isDirectory())packageDirs.push(d)};continue}
    if((await stat(dir)).isDirectory())packageDirs.push(dir)
  }
}
for(const dir of packageDirs){
  const files=await readdir(dir)
  for(const entry of files){
    const full=join(dir,entry)
    const info=await stat(full)
    const keep=info.isDirectory()
      ? ['lib','compat','agent-presets'].includes(entry)
      : ['package.json','cordis.patch.yml','openapi.json','README.md'].includes(entry)||entry.startsWith('LICENSE')
    if(keep)await copy(full)
  }
}
// 根清单：沿用已发布 0.2.8 的依赖清单与锁定文件（依赖面与已验证发行版一致），只改版本号。
// 本版未新增第三方依赖；手工重算依赖会产生 commander 15→2 这类降级，不可接受。
const template=JSON.parse(execFileSync('sh',['-c','curl -sL https://registry.npmjs.org/@teloa/cli/-/cli-0.2.8.tgz | tar -xOzf - package/package.json'],{encoding:'utf8'}))
const rootManifest={...template,version,name:'@teloa/cli'}
await writeFile(join(stage,'package.json'),JSON.stringify(rootManifest,null,2)+'\n')
execFileSync('sh',['-c',`curl -sL https://registry.npmjs.org/@teloa/cli/-/cli-0.2.8.tgz | tar -xOzf - package/npm-shrinkwrap.json > ${join(stage,'npm-shrinkwrap.json')}`])
// 发行清单：对除自身与 shrinkwrap 外的所有文件算 sha256
const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex')
const walk=async base=>{
  const rows=[]
  for(const entry of await readdir(base,{withFileTypes:true})){
    const full=join(base,entry.name)
    if(entry.isDirectory())rows.push(...await walk(full))
    else rows.push(full)
  }
  return rows
}
const files=[]
for(const full of await walk(stage)){
  const path=relative(stage,full).split('\\\\').join('/')
  if(path==='release-manifest.json'||path==='npm-shrinkwrap.json')continue
  files.push({path,sha256:await digest(full)})
}
files.sort((a,b)=>a.path.localeCompare(b.path))
await writeFile(join(stage,'release-manifest.json'),JSON.stringify({contactProfile:'community',schema:'teloa.release/v1',version,dshVersion,dataVersion:2,compatibleDataVersions:[2],files},null,2)+'\n')
const tgz=join(outDir,`teloa-cli-${version}.tgz`)
execFileSync('tar',['czf',tgz,'-C',outDir,'package'])
console.log(JSON.stringify({tgz,files:files.length+2,dshVersion,version}))
