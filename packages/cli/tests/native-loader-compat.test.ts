import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile,realpath,symlink,readlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname,relative} from 'node:path'
import {createRequire} from 'node:module'

const api=await import('../src/native-loader-compat.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {prepareNativeLoader:async()=>{}};throw error})
const family='node-addon-require-builtin',loaderName='node-addon-native-custom-loader',binding=family+'-darwin-arm64'
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-compat-')))
 const wrapper=join(root,'node_modules/.teloa-store/w/node_modules',family),loader=join(root,'node_modules/.teloa-store/l/node_modules',loaderName),native=join(root,'node_modules/.teloa-store/n/node_modules',binding)
 for(const [path,name,body] of [[wrapper,family,{dependencies:{[loaderName]:'0.1.6'},optionalDependencies:{[binding]:'0.1.6',[family+'-linux-x64-gnu']:'0.1.6'}}],[loader,loaderName,{}],[native,binding,{}]] as const){
  await mkdir(path,{recursive:true});await writeFile(join(path,'package.json'),JSON.stringify({name,version:'0.1.6',main:'index.cjs',...body}))
 }
 await writeFile(join(loader,'index.cjs'),`module.exports=()=>require('${binding}')`)
 await writeFile(join(native,'index.cjs'),"module.exports='native-ready'")
 await symlink(relative(dirname(wrapper),loader),join(dirname(wrapper),loaderName))
 await symlink(relative(dirname(wrapper),native),join(dirname(wrapper),binding))
 await writeFile(join(root,'runtime-dependencies.json'),JSON.stringify([{name:family,version:'0.1.6',path:relative(root,wrapper)}]))
 return {root,wrapper,loader,native,require:createRequire(join(loader,'package.json'))}
}
test('旧安装器副本中的共享加载器无需更新命令即可读取调用方的原生绑定',async()=>{
 const f=await fixture();assert.throws(()=>f.require('./index.cjs')(),{code:'MODULE_NOT_FOUND'})
 await api.prepareNativeLoader(f.root)
 assert.equal(f.require('./index.cjs')(),'native-ready')
 await api.prepareNativeLoader(f.root)
 assert.equal(f.require('./index.cjs')(),'native-ready','重复启动保持幂等')
})
test('新版已经能读取绑定时不创建额外加载路径',async()=>{
 const f=await fixture();await symlink(relative(join(f.root,'node_modules'),f.native),join(f.root,'node_modules',binding))
 await api.prepareNativeLoader(f.root)
 assert.equal(f.require('./index.cjs')(),'native-ready')
 await assert.rejects(readlink(join(f.loader,'node_modules',binding)),{code:'ENOENT'})
})
test('拒绝运行目录外的依赖路径，不创建外部连接',async()=>{
 const f=await fixture(),outside=await realpath(await mkdtemp(join(tmpdir(),'teloa-native-outside-')))
 await writeFile(join(f.root,'runtime-dependencies.json'),JSON.stringify([{name:family,version:'0.1.6',path:relative(f.root,outside)}]))
 await assert.rejects(api.prepareNativeLoader(f.root),/目录|路径/)
 await assert.rejects(readlink(join(f.loader,'node_modules',binding)),{code:'ENOENT'})
})
test('已有加载路径指向不同绑定时拒绝覆盖',async()=>{
 const f=await fixture(),conflict=join(f.root,'other');await mkdir(conflict);await writeFile(join(conflict,'package.json'),JSON.stringify({name:binding,version:'0.1.5'}))
 await mkdir(join(f.loader,'node_modules'));const path=join(f.loader,'node_modules',binding);await symlink(relative(dirname(path),conflict),path)
 await assert.rejects(api.prepareNativeLoader(f.root),/冲突|不一致/)
 assert.equal(await realpath(path),conflict)
})
