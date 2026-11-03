import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,stat} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {pinRuntimePnpm,runtimePnpmVersion} from '../scripts/release/runtime-pnpm.mjs'
const api=await import('../scripts/release/package-files.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error})
test('真实发行入口接受稳定版及正整数 RC，路径与空白版本在任何输出前拒绝',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-release-version-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const entry=fileURLToPath(new URL('../scripts/生成发行包.mjs',import.meta.url)),output=join(root,'output')
 for(const version of ['0.2.11','0.2.11-rc.1','0.2.11-rc.12']){
  const result=spawnSync(process.execPath,[entry,version,output],{cwd:root,encoding:'utf8',timeout:10000})
  assert.equal(result.status,1);assert.match(result.stderr,/dsh-baseline\.json/,'合法版本已进入正常来源读取，而非被版本门拒绝')
 }
 for(const version of ['', '../0.2.11','0.2.11/other','0.2.11;echo unsafe',' 0.2.11','0.2.11\n','0.2.11-rc.1\n','0.2.11-rc.0','0.2.11-rc.01','0.2.11-rc.-1','0.2.11-beta.1','next']){
  const result=spawnSync(process.execPath,[entry,version,output],{cwd:root,encoding:'utf8',timeout:10000})
  assert.equal(result.status,1);assert.match(result.stderr,/需要稳定版或 RC 版本号/)
 }
 await assert.rejects(stat(output),{code:'ENOENT'})
})
test('旧发行模板升级运行时 pnpm，包与 npm 锁一致且其他依赖闭包保持原样',()=>{
 const manifest={dependencies:{pnpm:'11.7.0',pg:'8.23.0'}}
 const lock={lockfileVersion:3,packages:{'':{name:'@teloa/cli',dependencies:{...manifest.dependencies}},'node_modules/pnpm':{version:'11.7.0',resolved:'old',integrity:'old'},'node_modules/pg':{version:'8.23.0',integrity:'keep'}}}
 const pg=structuredClone(lock.packages['node_modules/pg'])
 pinRuntimePnpm(manifest,lock)
 assert.equal(manifest.dependencies.pnpm,'11.23.0')
 assert.equal(lock.packages[''].dependencies.pnpm,runtimePnpmVersion)
 assert.equal(lock.packages['node_modules/pnpm'].version,runtimePnpmVersion)
 assert.equal(lock.packages['node_modules/pnpm'].resolved,'https://registry.npmjs.org/pnpm/-/pnpm-11.23.0.tgz')
 assert.deepEqual(lock.packages['node_modules/pg'],pg)
 assert.equal(manifest.dependencies.pg,'8.23.0')
 pinRuntimePnpm(manifest,lock)
 assert.equal(lock.packages['node_modules/pnpm'].version,runtimePnpmVersion)
})
test('发行模板的 pnpm 锁漂移或另有嵌套依赖时拒绝，不能生成貌似完整的新固定输入',()=>{
 for(const packages of [
  {'':{dependencies:{pnpm:'11.6.0'}},'node_modules/pnpm':{version:'11.7.0'}},
  {'':{dependencies:{pnpm:'11.7.0'}},'node_modules/pnpm':{version:'11.7.0'},'node_modules/other/node_modules/pnpm':{version:'11.7.0'}},
  {'':{dependencies:{pnpm:'11.7.0'}},'node_modules/pnpm':{version:'11.7.0',dependencies:{unknown:'1'}}},
 ])assert.throws(()=>pinRuntimePnpm({dependencies:{pnpm:'11.7.0'}},{packages}),/pnpm.*不一致/)
})
const fastShaApi=await import('../scripts/release/runtime-fast-sha256.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error})
const fastShaSource=await readFile(new URL('../pnpm-lock.yaml',import.meta.url),'utf8')
const fastShaNode={version:'1.3.0',resolved:'https://registry.npmjs.org/fast-sha256/-/fast-sha256-1.3.0.tgz',integrity:'sha512-n11RGP/lrWEFI/bWdygLxhI+pVeo1ZYIVwvvPkW7azl/rOy+F3HYRZ2K5zeE9mmkhQppyv9sQFx0JM9UabnpPQ=='}
function fastShaFixture(){return {manifest:{dependencies:{pg:'8.23.0'}},lock:{packages:{'':{dependencies:{pg:'8.23.0'}},'node_modules/fast-sha256':structuredClone(fastShaNode),'node_modules/pg':{version:'8.23.0'}}}}}
test('发行直接依赖从已固定的 fast-sha256 叶提升，其他锁节点逐字保留',()=>{
 assert.equal(typeof fastShaApi.pinRuntimeFastSha256,'function')
 const {manifest,lock}=fastShaFixture(),before=structuredClone(lock)
 fastShaApi.pinRuntimeFastSha256(manifest,lock,{dependencies:{'fast-sha256':'1.3.0'}},fastShaSource)
 assert.equal(manifest.dependencies['fast-sha256'],'1.3.0');assert.equal(lock.packages[''].dependencies['fast-sha256'],'1.3.0')
 assert.deepEqual(lock.packages['node_modules/fast-sha256'],before.packages['node_modules/fast-sha256']);assert.deepEqual(lock.packages['node_modules/pg'],before.packages['node_modules/pg'])
})
test('发行 fast-sha256 缺叶或版本来源摘要漂移在变更前明确拒绝',()=>{
 for(const mutate of [f=>delete f.lock.packages['node_modules/fast-sha256'],f=>f.lock.packages['node_modules/fast-sha256'].version='1.2.0',f=>f.lock.packages['node_modules/fast-sha256'].resolved='https://example.test/other.tgz',f=>f.lock.packages['node_modules/fast-sha256'].integrity='sha512-invalid']){
  const f=fastShaFixture();mutate(f);const before=structuredClone(f)
  assert.throws(()=>fastShaApi.pinRuntimeFastSha256(f.manifest,f.lock,{dependencies:{'fast-sha256':'1.3.0'}},fastShaSource),/fast-sha256/);assert.deepEqual(f,before)
 }
 const f=fastShaFixture();assert.throws(()=>fastShaApi.pinRuntimeFastSha256(f.manifest,f.lock,{dependencies:{'fast-sha256':'1.2.0'}},fastShaSource),/fast-sha256/)
 assert.throws(()=>fastShaApi.pinRuntimeFastSha256(f.manifest,f.lock,{dependencies:{'fast-sha256':'1.3.0'}},fastShaSource.replace(fastShaNode.integrity,'sha512-invalid')),/fast-sha256/)
})
async function fixture(t,directory,manifest,files){
 const root=await mkdtemp(join(tmpdir(),'teloa-release-files-')),stage=join(root,'stage with spaces')
 t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'packages',directory)
 const config={compilerOptions:{rootDir:'src',outDir:directory==='client/ui-workbench'?'lib/types':'lib',declaration:true,module:'ESNext',moduleResolution:'bundler',jsx:'react-jsx'},include:['src']}
 for(const [file,text] of Object.entries({'package.json':JSON.stringify(manifest),'tsconfig.json':JSON.stringify(config),...files})){
  const path=join(source,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,text)
 }
 return {root,stage,directory,version:'0.2.10',dependencies:{pg:'8.23.0'}}
}
test('编译包的条件出口能实际加载，运行清单不携带开发命令或 workspace 协议',async t=>{
 assert.equal(typeof api.prepareReleasePackage,'function','缺少发行文件装配与出口核验')
 const options=await fixture(t,'contract',{name:'@teloa/contract',version:'0.2.4',private:true,type:'module',exports:{'.':{default:'./src/index.ts'},'./package.json':'./package.json'},dependencies:{'@teloa/backend':'workspace:*',pg:'8.23.0','fast-sha256':'1.3.0'},devDependencies:{typescript:'5'},scripts:{test:'never-ship'}},{'lib/index.js':'export const answer=42','lib/index.js.map':'private/source/path','src/index.ts':'not for shipping'})
 options.version='0.2.11-rc.1'
 options.dependencies['fast-sha256']='1.3.0'
 await api.prepareReleasePackage(options)
 const dir=join(options.stage,'packages/contract'),manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'))
 assert.equal(manifest.exports['.'].default,'./lib/index.js')
 assert.equal((await import(join(dir,manifest.exports['.'].default))).answer,42)
 assert.equal(manifest.version,'0.2.11-rc.1')
 assert.deepEqual(manifest.dependencies,{'@teloa/backend':'0.2.11-rc.1',pg:'8.23.0','fast-sha256':'1.3.0'})
 assert.equal(manifest.scripts,undefined);assert.equal(manifest.devDependencies,undefined)
 await assert.rejects(stat(join(dir,'lib/index.js.map')),{code:'ENOENT'})
 await assert.rejects(stat(join(dir,'src/index.ts')),{code:'ENOENT'})
})
test('声明型命令按 files 白名单发行，命令具备执行位',async t=>{
 assert.equal(typeof api.prepareReleasePackage,'function','缺少声明型包装配')
 const options=await fixture(t,'native-remote',{name:'@teloa/native-remote',type:'module',exports:{'.':'./profile.mjs'},bin:{'teloa-remote-profile':'./bin.mjs'},files:['profile.mjs','bin.mjs','README.md']},{'profile.mjs':'export const ready=true','bin.mjs':'#!/usr/bin/env node\nconsole.log("ready")','README.md':'usage','private.txt':'must not ship'})
 await api.prepareReleasePackage(options)
 const dir=join(options.stage,'packages/native-remote')
 assert.equal((await import(join(dir,'profile.mjs'))).ready,true)
 assert.ok((await stat(join(dir,'bin.mjs'))).mode&0o111)
 await assert.rejects(stat(join(dir,'private.txt')),{code:'ENOENT'})
})
test('SDK 的实现、类型和契约入口同时保留',async t=>{
 assert.equal(typeof api.prepareReleasePackage,'function','缺少 SDK 装配')
 const options=await fixture(t,'sdk',{name:'@teloa/sdk',type:'module',exports:{'.':{types:'./index.d.mts',default:'./index.mjs'},'./contract':'./contract.mjs'},files:['index.mjs','index.d.mts','contract.mjs']},{'index.mjs':'export const ready=true','index.d.mts':'export declare const ready:boolean','contract.mjs':'export const schema=1'})
 await api.prepareReleasePackage(options)
 const dir=join(options.stage,'packages/sdk')
 assert.equal((await import(join(dir,'index.mjs'))).ready,true)
 assert.equal((await import(join(dir,'contract.mjs'))).schema,1)
 assert.match(await readFile(join(dir,'index.d.mts'),'utf8'),/declare const ready/)
})
test('本地嵌入发行包含运行配方、固定工件清单及来源许可，不包含模型权重',async t=>{
 assert.equal(typeof api.prepareReleasePackage,'function','缺少检索运行资产装配')
 const options=await fixture(t,'local-embedding',{name:'@teloa/local-embedding',exports:'./src/index.ts'},{'src/index.ts':'export{}','lib/index.js':'export{}','cordis.patch.yml':'[]','runtime/assets.json':'{"model":"fixed"}','runtime/onnxruntime.json':'{"recipe":"fixed"}','runtime/model.onnx':'private binary','PROVENANCE.md':'origin','LICENSE-MODEL':'license'})
 await api.prepareReleasePackage(options)
 const dir=join(options.stage,'packages/local-embedding')
 for(const file of ['runtime/assets.json','runtime/onnxruntime.json','PROVENANCE.md','LICENSE-MODEL'])assert.ok((await stat(join(dir,file))).isFile())
 await assert.rejects(stat(join(dir,'runtime/model.onnx')),{code:'ENOENT'})
})
test('缺少入口与符号链接在装配时拒绝，不能生成看似完整的发行包',async t=>{
 assert.equal(typeof api.prepareReleasePackage,'function','缺少发行拒绝条件')
 const options=await fixture(t,'contract',{name:'@teloa/contract',exports:'./src/missing.ts'},{'src/index.ts':'export{}','lib/index.js':'export{}'})
 await assert.rejects(api.prepareReleasePackage(options),/入口|出口|missing/)
 const linked=await fixture(t,'native-remote',{name:'@teloa/native-remote',files:['profile.mjs'],exports:'./profile.mjs'},{'elsewhere.mjs':'export{}'})
 await symlink(join(linked.root,'packages/native-remote/elsewhere.mjs'),join(linked.root,'packages/native-remote/profile.mjs'))
 await assert.rejects(api.prepareReleasePackage(linked),/符号链接/)
})

test('已删源码的JS和声明残留在复制前拒绝，不能发行也不删除用户lib',async t=>{
 const options=await fixture(t,'contract',{name:'@teloa/contract',exports:'./src/index.ts'},{'src/index.ts':'export const current=true','lib/index.js':'export const current=true','lib/deleted-feature.js':'export const retired=true','lib/deleted-feature.d.ts':'export declare const retired:boolean'})
 await assert.rejects(api.prepareReleasePackage(options),error=>/无当前来源/.test(error.message)&&error.message.includes('lib/deleted-feature.js')&&error.message.includes('lib/deleted-feature.d.ts'))
 await assert.rejects(stat(join(options.stage,'packages/contract')),{code:'ENOENT'})
 assert.equal(await readFile(join(options.root,'packages/contract/lib/deleted-feature.js'),'utf8'),'export const retired=true')
})

test('存在但已被tsconfig排除的源码不能给陈旧输出背书',async t=>{
 const options=await fixture(t,'contract',{name:'@teloa/contract',exports:'./src/index.ts'},{'tsconfig.json':JSON.stringify({compilerOptions:{rootDir:'src',outDir:'lib',declaration:true},include:['src'],exclude:['src/retired.ts']}),'src/index.ts':'export{}','src/retired.ts':'export{}','lib/index.js':'export{}','lib/retired.js':'export{}'})
 await assert.rejects(api.prepareReleasePackage(options),/无当前来源.*lib\/retired\.js/s)
})

test('当前tsconfig的TS/TSX/MTS/CTS输出及原样复制资产都能保留',async t=>{
 const files={'src/index.ts':'export{}','lib/index.js':'export{}','lib/index.d.ts':'export{}','src/nested/view.tsx':'export const view=1','lib/nested/view.js':'export const view=1','lib/nested/view.d.ts':'export declare const view=1','src/esm.mts':'export{}','lib/esm.mjs':'export{}','lib/esm.d.mts':'export{}','src/common.cts':'export{}','lib/common.cjs':'export{}','lib/common.d.cts':'export{}','src/copied.mjs':'export const copied=1','lib/copied.mjs':'export const copied=1','src/copied.d.mts':'export declare const copied=1','lib/copied.d.mts':'export declare const copied=1','src/schema.json':'{"current":true}','lib/schema.json':'{"current":true}'}
 const options=await fixture(t,'contract',{name:'@teloa/contract',exports:'./src/index.ts'},files);await api.prepareReleasePackage(options)
 for(const [path,text] of Object.entries(files).filter(([path])=>path.startsWith('lib/')))assert.equal(await readFile(join(options.stage,'packages/contract',path),'utf8'),text)
})

const clientFiles={
 'src/index.ts':'export{}','src/client/index.ts':'export{}','src/client/chart.ts':'export{}','src/client/guest.tsx':'export{}','src/client/guest-styles.ts':'export{}',
 '../tsdown.preset.ts':'export function clientBundle(){};export function clientChunk(){};export function standaloneClientBundle(){}',
 'tsdown.config.ts':"import {clientBundle,clientChunk,standaloneClientBundle} from '../tsdown.preset.ts';const configs=clientBundle('@teloa/client-ui-workbench','src/client/index.ts');const chart=clientChunk('@teloa/client-ui-workbench','chart','src/client/chart.ts');export default [...configs,chart,standaloneClientBundle('@teloa/client-ui-workbench','src/client/guest.tsx','src/client/guest-styles.ts')];",
 'lib/types/index.js':'export{}','lib/types/index.d.ts':'export{}','lib/types/client/index.js':'export{}','lib/types/client/index.d.ts':'export{}',
 'lib/index.js':'export{}','lib/client.js':'window.__ModuleLoader__.load({})','lib/client.chart.js':'window.__ModuleLoader__.load({})','lib/guest.js':'export{}',
}
test('工作台tsc类型目录和明确配置的host/client/chunk/guest打包输出保留',async t=>{
 const options=await fixture(t,'client/ui-workbench',{name:'@teloa/client-ui-workbench',exports:{'.':{types:'./lib/types/index.d.ts',default:'./lib/index.js'},'./client':'./lib/client.js','./guest':'./lib/guest.js'}},clientFiles);await api.prepareReleasePackage(options)
 for(const path of ['lib/index.js','lib/client.js','lib/client.chart.js','lib/guest.js','lib/types/client/index.d.ts'])assert.ok((await stat(join(options.stage,'packages/client/ui-workbench',path))).isFile())
})
test('工作台类型目录的孤立输出和没有当前构建声明的client分块均拒绝',async t=>{
 for(const orphan of ['lib/types/client/deleted-reader.js','lib/types/client/deleted-reader.d.ts','lib/client.retired.js']){
  const options=await fixture(t,'client/ui-workbench',{name:'@teloa/client-ui-workbench',exports:'./lib/index.js'},{...clientFiles,'src/client/retired.ts':'export{}',[orphan]:'export{}'})
  await assert.rejects(api.prepareReleasePackage(options),error=>error.message.includes('无当前来源')&&error.message.includes(orphan))
 }
})
test('仍有声明和源码但已从默认导出移除的chunk不能给陈旧输出背书',async t=>{
 const files={...clientFiles,'tsdown.config.ts':clientFiles['tsdown.config.ts'].replace('...configs,chart,','...configs,')}
 const options=await fixture(t,'client/ui-workbench',{name:'@teloa/client-ui-workbench',exports:'./lib/index.js'},files)
 await assert.rejects(api.prepareReleasePackage(options),/无当前来源.*lib\/client\.chart\.js/s)
 await assert.rejects(stat(join(options.stage,'packages/client/ui-workbench')),{code:'ENOENT'})
})
test('默认导出的静态数组与const别名可达，未知或循环声明不推定为构建来源',async t=>{
 const original=clientFiles['tsdown.config.ts'],declarations=original.slice(0,original.indexOf('export default'))
 const valid=await fixture(t,'client/ui-workbench',{name:'@teloa/client-ui-workbench',exports:'./lib/index.js'},{...clientFiles,'tsdown.config.ts':declarations+"const selected=[...configs,chart,standaloneClientBundle('@teloa/client-ui-workbench','src/client/guest.tsx','src/client/guest-styles.ts')];const current=selected;export default current;"})
 await api.prepareReleasePackage(valid)
 for(const suffix of ['export default [...configs,unknown];','const first=second;const second=first;export default first;','export default getConfigs();','export default [...chart];']){
  const options=await fixture(t,'client/ui-workbench',{name:'@teloa/client-ui-workbench',exports:'./lib/index.js'},{...clientFiles,'tsdown.config.ts':declarations+suffix})
  await assert.rejects(api.prepareReleasePackage(options),/默认导出.*(?:无法确定|循环|数组)/)
 }
})
