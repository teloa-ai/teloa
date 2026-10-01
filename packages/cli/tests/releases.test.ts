import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,readFile,rename,realpath,symlink} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {resolveLayout} from '../src/layout.ts'
const api=await import('../src/releases.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error}) as any
async function fixture(alias=false){
 const base=await realpath(await mkdtemp(join(tmpdir(),'teloa-release-'))),source=join(base,'npm/node_modules/@teloa/cli')
 await mkdir(source,{recursive:true})
 const data=[['package.json',JSON.stringify({name:'@teloa/cli',version:'1.0.0',type:'module',dependencies:{demo:alias?'npm:real-demo@1.0.0':'1.0.0'}})],['bin.js',"import demo from 'demo';console.log(demo)"],['packages/contract/package.json',JSON.stringify({name:'@teloa/contract',exports:'./lib/index.js',type:'module'})],['packages/contract/lib/index.js','export default 42']]
 const files=[]
 for(const [path,text] of data){await mkdir(dirname(join(source,path!)),{recursive:true});await writeFile(join(source,path!),text!);files.push({path,sha256:createHash('sha256').update(text!).digest('hex')})}
 const dep=join(base,'npm/node_modules/demo');await mkdir(dep,{recursive:true})
 await writeFile(join(dep,'package.json'),JSON.stringify({name:alias?'real-demo':'demo',version:'1.0.0',main:'index.js'}));await writeFile(join(dep,'index.js'),'module.exports=42')
 const manifest={schema:'teloa.release/v1',version:'1.0.0',dshVersion:'0.1.6-alpha.1',dataVersion:1,compatibleDataVersions:[1],files}
 await writeFile(join(source,'release-manifest.json'),JSON.stringify(manifest))
 const layout=await resolveLayout({home:join(base,'home'),version:'1.0.0'})
 return {source,base,layout,manifest}
}
test('发行副本捕获 npm 提升依赖，原安装被移走后仍可执行',async()=>{
 assert.equal(typeof api.stageRelease,'function','缺少独立发行版本保存')
 const {source,base,layout}=await fixture()
 await api.stageRelease(source,layout)
 await rename(join(base,'npm'),join(base,'removed-npm'))
 const result=spawnSync(process.execPath,[join(layout.releaseRoot,'bin.js')],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'42')
 assert.equal(await realpath(join(layout.releaseRoot,'node_modules/@teloa/contract')),join(layout.releaseRoot,'packages/contract'))
})
test('篡改文件与路径穿越在发布副本前拒绝',async()=>{
 assert.equal(typeof api.stageRelease,'function','缺少发行校验')
 const {source,layout,manifest}=await fixture()
 await writeFile(join(source,'bin.js'),'modified')
 await assert.rejects(api.stageRelease(source,layout),/摘要/)
 manifest.files.push({path:'../outside',sha256:'0'.repeat(64)})
 await writeFile(join(source,'release-manifest.json'),JSON.stringify(manifest))
 await assert.rejects(api.stageRelease(source,layout),/路径/)
})
test('npm alias 原生包按声明的真实包名核验并保留别名入口',async()=>{
 const {source,layout}=await fixture(true)
 await api.stageRelease(source,layout)
 const result=spawnSync(process.execPath,[join(layout.releaseRoot,'bin.js')],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'42')
})
test('依赖内部绝对软链在副本中改为内部相对路径',async()=>{
 const {source,base,layout}=await fixture()
 const directory=join(base,'npm/node_modules/demo')
 await rename(join(directory,'index.js'),join(directory,'actual.js'))
 await symlink(join(directory,'actual.js'),join(directory,'index.js'))
 await api.stageRelease(source,layout)
 await rename(join(base,'npm'),join(base,'removed-npm'))
 const result=spawnSync(process.execPath,[join(layout.releaseRoot,'bin.js')],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'42')
})
test('原生共享库依赖在包同级可达，复制后仍满足相对加载路径',async()=>{
 const {source,base,layout}=await fixture()
 const demo=join(base,'npm/node_modules/demo'),binding=join(base,'npm/node_modules/@native/binding'),library=join(base,'npm/node_modules/@native/library')
 await mkdir(binding,{recursive:true});await mkdir(library,{recursive:true})
 await writeFile(join(demo,'package.json'),JSON.stringify({name:'demo',version:'1.0.0',main:'index.js',dependencies:{'@native/binding':'1.0.0'}}))
 await writeFile(join(demo,'index.js'),"module.exports=require('@native/binding')")
 await writeFile(join(binding,'package.json'),JSON.stringify({name:'@native/binding',version:'1.0.0',main:'index.js',optionalDependencies:{'@native/library':'1.0.0'}}))
 // 对应原生库的相对 rpath：它不使用 Node.js 的嵌套依赖解析。
 await writeFile(join(binding,'index.js'),"module.exports=require('node:fs').readFileSync(require('node:path').join(__dirname,'../library/value.txt'),'utf8')")
 await writeFile(join(library,'package.json'),JSON.stringify({name:'@native/library',version:'1.0.0'}));await writeFile(join(library,'value.txt'),'native-bytes')
 await api.stageRelease(source,layout);await rename(join(base,'npm'),join(base,'removed-npm'))
 const result=spawnSync(process.execPath,[join(layout.releaseRoot,'bin.js')],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'native-bytes')
})
test('依赖环和多个版本在独立副本中各自解析，移走原安装后仍可执行',async()=>{
 const {source,base,layout,manifest}=await fixture()
 const modules=join(base,'npm/node_modules')
 for(const [path,name,version,dependencies,body] of [
  ['demo','demo','1.0.0',{b:'1.0.0',c:'1.0.0'},"exports.value=()=>require('c');exports.read=()=>({a:exports.value(),b:require('b').value(),back:require('b').fromA()})"],
  ['b','b','1.0.0',{demo:'1.0.0',c:'2.0.0'},"exports.value=()=>require('c');exports.fromA=()=>require('demo').value()"],
  ['c','c','1.0.0',{},"module.exports='C1'"],
  ['b/node_modules/c','c','2.0.0',{},"module.exports='C2'"],
 ] as const){
  const directory=join(modules,path);await mkdir(directory,{recursive:true})
  await writeFile(join(directory,'package.json'),JSON.stringify({name,version,main:'index.js',dependencies}))
  await writeFile(join(directory,'index.js'),body)
 }
 const entry="import demo from 'demo';console.log(JSON.stringify(demo.read()))"
 await writeFile(join(source,'bin.js'),entry)
 manifest.files.find(row=>row.path==='bin.js')!.sha256=createHash('sha256').update(entry).digest('hex')
 await writeFile(join(source,'release-manifest.json'),JSON.stringify(manifest))
 await api.stageRelease(source,layout);await rename(join(base,'npm'),join(base,'removed-npm'))
 const result=spawnSync(process.execPath,[join(layout.releaseRoot,'bin.js')],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{a:'C1',b:'C2',back:'C1'})
})
test('共享原生加载器保留源安装的提升可见性，不能把嵌套版本或私有包误提升',async()=>{
 const {source,base,layout,manifest}=await fixture()
 const modules=join(base,'npm/node_modules')
 // 对应 node-addon-native-custom-loader：调用方声明平台包，共享加载器用自己的 require 动态加载。
 // 先访问嵌套版本，防止把“最先复制的同名包”误当成安装根可见版本。
 for(const [path,name,version,dependencies,optionalDependencies,body] of [
  ['demo','demo','1.0.0',{'shared-loader':'1.0.0','nested-wrapper':'1.0.0'},{'native-binding':'1.0.0'},"const loader=require('shared-loader');module.exports={native:loader('native-binding'),nested:require('nested-wrapper'),privateVisible:loader('native-test-private-only')}"],
  ['shared-loader','shared-loader','1.0.0',{}, {},"module.exports=name=>{try{return require(name)}catch(error){if(error.code==='MODULE_NOT_FOUND')return 'missing';throw error}}"],
  ['nested-wrapper','nested-wrapper','1.0.0',{'native-binding':'2.0.0','native-test-private-only':'1.0.0'},{},"module.exports={native:require('native-binding'),private:require('native-test-private-only')}"],
  ['nested-wrapper/node_modules/native-binding','native-binding','2.0.0',{}, {},"module.exports='nested-v2'"],
  ['nested-wrapper/node_modules/native-test-private-only','native-test-private-only','1.0.0',{}, {},"module.exports='private'"],
  ['native-binding','native-binding','1.0.0',{}, {},"module.exports='native-v1'"],
 ] as const){
  const directory=join(modules,path);await mkdir(directory,{recursive:true})
  await writeFile(join(directory,'package.json'),JSON.stringify({name,version,main:'index.js',dependencies,optionalDependencies}))
  await writeFile(join(directory,'index.js'),body)
 }
 const entry="import demo from 'demo';console.log(JSON.stringify(demo))"
 await writeFile(join(source,'bin.js'),entry)
 manifest.files.find(row=>row.path==='bin.js')!.sha256=createHash('sha256').update(entry).digest('hex')
 await writeFile(join(source,'release-manifest.json'),JSON.stringify(manifest))
 const expected={native:'native-v1',nested:{native:'nested-v2',private:'private'},privateVisible:'missing'}
 const original=spawnSync(process.execPath,[join(source,'bin.js')],{encoding:'utf8'})
 assert.equal(original.status,0,original.stderr);assert.deepEqual(JSON.parse(original.stdout),expected)
 await api.stageRelease(source,layout);await rename(join(base,'npm'),join(base,'removed-npm'))
 const copied=spawnSync(process.execPath,[join(layout.releaseRoot,'bin.js')],{encoding:'utf8'})
 assert.equal(copied.status,0,copied.stderr);assert.deepEqual(JSON.parse(copied.stdout),expected)
 await assert.rejects(realpath(join(layout.releaseRoot,'node_modules/native-test-private-only')),{code:'ENOENT'})
})
