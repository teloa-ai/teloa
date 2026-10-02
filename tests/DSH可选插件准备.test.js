import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as setup from '../scripts/准备DSH插件.mjs'
import * as runtime from '../scripts/runtime/profile.mjs'

test('可选原生依赖目录包含 Browser、Computer、Auto review 与两个随附扩展，Remote 不登记到 Web',()=>{
 const specs=runtime.optionalNativeBundleSpecs(new URL('../',import.meta.url).pathname)
 assert.deepEqual(Object.keys(specs),['@teloa/native-browser','@teloa/native-computer','@deepseek-ai/dsh-experimental-auto-review','@teloa/im-gateway','@teloa/local-embedding'])
 assert.ok(Object.values(specs).every(spec=>spec.startsWith('link:')))
 assert.ok(!JSON.stringify(specs).includes('native-remote'))
})

test('npm profile：@teloa/ 随附包以官方值覆盖旧值，其它可选依赖保留用户来源与全部其它字段',()=>{
 const original={name:'profile',dependencies:{'@teloa/native-browser':'link:/old-release/browser','@deepseek-ai/dsh-experimental-auto-review':'file:/custom/review','other':'1.0.0'},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@teloa/native-browser']},custom:true},custom:{keep:true}}
 const next=runtime.withOptionalNativeDependencies(original,{'@teloa/native-browser':'link:/new/browser','@teloa/native-computer':'link:/new/computer','@deepseek-ai/dsh-experimental-auto-review':'link:/new/review'})
 assert.equal(next.dependencies['@teloa/native-browser'],'link:/new/browser')
 assert.equal(next.dependencies['@teloa/native-computer'],'link:/new/computer')
 assert.equal(next.dependencies['@deepseek-ai/dsh-experimental-auto-review'],'file:/custom/review')
 assert.equal(next.dependencies.other,'1.0.0')
 assert.deepEqual(next.dsh,original.dsh)
 assert.deepEqual(next.custom,original.custom)
 assert.equal(original.dependencies['@teloa/native-browser'],'link:/old-release/browser')
 assert.deepEqual(runtime.withOptionalNativeDependencies(next,{'@deepseek-ai/dsh-experimental-auto-review':'link:/other'}),next)
})

for(const result of ['success','throw','exit'])test(`可选安装 ${result} 均只调用官方禁用安装并重新压制市场 pending`,async()=>{
 const profileDir=await mkdtemp(join(tmpdir(),'teloa-optional-'))
 const manifest={dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@teloa/native-browser','@vendor/pending']}}}
 await writeFile(join(profileDir,'package.json'),JSON.stringify(manifest))
 await writeFile(join(profileDir,'teloa-待启用插件.json'),JSON.stringify({'@vendor/pending@1.0.0':'a'.repeat(64)}))
 const calls=[]
 const run=()=>setup.installOptionalNativeBundles({profileDir,profileName:'test',installAnchor:'/installation/package.json',specs:{'@teloa/native-browser':'link:/browser','@teloa/native-computer':'link:/computer','@deepseek-ai/dsh-experimental-auto-review':'link:/review'},operation:async(context,args,options)=>{
  calls.push({context,args,activate:options.activateNewBundles})
  if(result==='throw')throw Error('package manager failed')
  return {exitCode:result==='exit'?1:0}
 }})
 if(result==='throw')await assert.rejects(run,/package manager failed/)
 else if(result==='exit')await assert.rejects(run,/退出码 1/)
 else await run()
 assert.deepEqual(calls.map(call=>call.activate),[false])
 assert.deepEqual(calls[0].args,['add','link:/browser','link:/computer','link:/review'])
 assert.equal(calls[0].context.dir,profileDir)
 const after=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
 assert.deepEqual(after.dsh.profile.bundles,['@deepseek-ai/dsh-base','@teloa/native-browser'])
 assert.deepEqual(JSON.parse(await readFile(join(profileDir,'teloa-待启用插件.json'),'utf8')),{'@vendor/pending@1.0.0':'a'.repeat(64)})
})

test('官方 Team bundle 紧邻 Teloa 之前，保留其他 bundle 顺序且重跑不重复',()=>{
 const before=['@deepseek-ai/dsh-base','@teloa/bundle','@vendor/optional']
 const next=runtime.withTeloaRequiredBundles(before)
 assert.deepEqual(next,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-experimental-agent-team-profile','@teloa/bundle','@vendor/optional'])
 assert.deepEqual(runtime.withTeloaRequiredBundles(next),next)
 assert.deepEqual(runtime.withTeloaRequiredBundles(['base']),['base','@deepseek-ai/dsh-experimental-agent-team-profile','@teloa/bundle'])
})
test('随附 Auto Review 跟进 DSH 升级，手动来源保留；仅当前登记可修复链接',()=>{
 const name='@deepseek-ai/dsh-experimental-auto-review'
 const previous='link:/old-program/node_modules/.pnpm/@deepseek-ai+dsh-experimental-auto-review@0.1.7-rc.1/node_modules/'+name
 const current='link:/new-program/node_modules/.pnpm/@deepseek-ai+dsh-experimental-auto-review@0.2.0-rc.2/node_modules/'+name
 const specs={[name]:current},manifest={dependencies:{[name]:previous}}
 const next=runtime.withOptionalNativeDependencies(manifest,specs)
 assert.equal(next.dependencies[name],current)
 assert.deepEqual(runtime.managedAutoReviewModuleSpec(next,specs),specs)
 assert.deepEqual(runtime.managedAutoReviewModuleSpec(manifest,specs),{})
 for(const custom of ['file:/custom/review','0.1.7-rc.1','link:/custom/review'])assert.equal(runtime.withOptionalNativeDependencies({dependencies:{[name]:custom}},specs).dependencies[name],custom)
})

test('发行 Auto Review 链接随应用目录更新，独立安装的 store 摘要变化也可修复',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-review-release-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const name='@deepseek-ai/dsh-experimental-auto-review'
 const source=join(root,'原应用 With Spaces/Teloa.app/node_modules/.teloa-store','a'.repeat(24),'node_modules',name)
 const target=join(root,'新应用 With Spaces/Teloa.app/node_modules/.teloa-store','b'.repeat(24),'node_modules',name)
 const profile=join(root,'profile'),link=join(profile,'node_modules',name)
 for(const path of [source,target,join(profile,'node_modules/@deepseek-ai')])await mkdir(path,{recursive:true})
 await symlink(source,link)
 const before={dependencies:{[name]:'link:'+source,other:'1.0.0'},dsh:{profile:{bundles:['base']}},custom:{keep:true}}
 const specs={[name]:'link:'+target},after=runtime.withOptionalNativeDependencies(before,specs)
 assert.equal(after.dependencies[name],specs[name])
 assert.deepEqual(after.dsh,before.dsh)
 assert.deepEqual(after.custom,before.custom)
 assert.equal(after.dependencies.other,'1.0.0')
 assert.equal(before.dependencies[name],'link:'+source)
 await runtime.repairBundledModuleLinks(profile,runtime.managedAutoReviewModuleSpec(after,specs))
 assert.equal(await realpath(link),await realpath(target))
 assert.deepEqual(await runtime.bundledModuleConflicts(profile,specs),[])
 await runtime.repairBundledModuleLinks(profile,runtime.managedAutoReviewModuleSpec(after,specs))
 assert.equal(await realpath(link),await realpath(target))
})

test('发行 Auto Review 仅识别完整随附布局，未知或本人来源不改写',()=>{
 const name='@deepseek-ai/dsh-experimental-auto-review'
 const specs={[name]:'link:/current/node_modules/.teloa-store/'+ 'a'.repeat(24)+'/node_modules/'+name}
 const custom=['file:/custom/review','0.2.0-rc.2','link:/custom/review',
  'link:/old/node_modules/.teloa-store/'+ 'a'.repeat(23)+'/node_modules/'+name,
  'link:/old/node_modules/.teloa-store/'+ 'A'.repeat(24)+'/node_modules/'+name,
  'link:/old/node_modules/.teloa-store/'+ 'a'.repeat(24)+'/node_modules/@vendor/review',
  'link:/old/node_modules/.teloa-store/'+ 'a'.repeat(24)+'/node_modules/'+name+'/other']
 for(const spec of custom){
  const before={dependencies:{[name]:spec}},after=runtime.withOptionalNativeDependencies(before,specs)
  assert.equal(after.dependencies[name],spec)
  assert.deepEqual(runtime.managedAutoReviewModuleSpec(after,specs),{})
 }
})
