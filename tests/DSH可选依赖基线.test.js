import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {verifyDshPackages} from '../scripts/核对DSH依赖.mjs'

test('固定基线包含独立安装的 Browser、Computer、SSH、Auto review 官方提供方',()=>{
 const packages=new Map(verifyDshPackages().map(row=>[row.name,row.version]))
 for(const name of ['dsh-browser-use','dsh-experimental-browser-use-playwright-mcp','dsh-computer-use','dsh-experimental-computer-use-cua-driver-native','dsh-ssh','dsh-fs-ssh','dsh-subprocess-ssh','dsh-sandbox-ssh','dsh-experimental-auto-review'])assert.equal(packages.get('@deepseek-ai/'+name),'0.2.0-rc.2',name)
})

test('本地中文检索扩展：DSH 依赖在固定基线内；onnxruntime-node 只经受管安装，不进任何 workspace 清单与锁文件',async()=>{
 const {readFile}=await import('node:fs/promises')
 const {execFileSync}=await import('node:child_process')
 const root=new URL('../',import.meta.url)
 const packages=new Map(verifyDshPackages().map(row=>[row.name,row.version]))
 const manifest=JSON.parse(await readFile(new URL('packages/local-embedding/package.json',root),'utf8'))
 for(const [name,version] of Object.entries(manifest.dependencies)){
  if(name==='@deepseek-ai/cordis')assert.equal(version,'4.0.4')
  else if(name.startsWith('@deepseek-ai/'))assert.equal(packages.get(name),version,name)
 }
 assert.equal(manifest.dependencies['@huggingface/tokenizers'],'0.2.0')
 for(const field of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])assert.equal(manifest[field]?.['onnxruntime-node'],undefined,field)
 const tracked=execFileSync('git',['ls-files','package.json','packages/**/package.json','pnpm-workspace.yaml','pnpm-lock.yaml'],{cwd:root,encoding:'utf8'}).trim().split('\n')
 for(const file of tracked)assert.doesNotMatch(await readFile(new URL(file,root),'utf8'),/onnxruntime-node/,file)
})

test('dsh-app-boot 全安装图只有一份实例：官方扩展即时启停调用的 reconcileProfilePatches 靠模块级根 Include 表，两份实例会找不到根 Include',()=>{
 assert.equal(verifyDshPackages().filter(row=>row.name==='@deepseek-ai/dsh-app-boot').length,1)
})

test('官方办公提供方的辅助库钉位满足其发布清单要求，不能让 pnpm override 掩盖旧版',()=>{
 const packages=verifyDshPackages()
 for(const name of ['@deepseek-ai/dsh-office-to-pdf','@deepseek-ai/dsh-skill-office']){
  const provider=packages.find(row=>row.name===name)
  assert.ok(provider,name)
  const manifest=JSON.parse(readFileSync(provider.path,'utf8'))
  const kit=packages.find(row=>row.name==='@deepseek-ai/libreoffice-kit')
  assert.ok(kit,'官方 LibreOffice Kit 应在真实安装图中')
  const dsh=packages.find(row=>row.name==='@deepseek-ai/dsh')
  const {satisfies}=createRequire(dsh.path)('semver')
  assert.equal(satisfies(kit.version,manifest.dependencies['@deepseek-ai/libreoffice-kit']),true,name+' 的办公辅助库版本要求')
 }
})
