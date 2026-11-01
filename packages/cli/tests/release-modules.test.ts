import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {withReleaseModule} from '../src/release-modules.ts'
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
async function fixture(t:{after:(run:()=>Promise<void>)=>void},marker:string){
 const root=await mkdtemp(join(tmpdir(),'teloa-release-modules-')),files:Record<string,string>={
  'package.json':JSON.stringify({type:'module'}),
  'packages/contract/package.json':JSON.stringify({name:'@teloa/contract',version:'1.0.0',type:'module',exports:{'.':'./lib/index.js'}}),
  'packages/contract/lib/index.js':`export const marker=${JSON.stringify(marker)}`,
  'packages/backend/package.json':JSON.stringify({name:'@teloa/backend',version:'1.0.0',type:'module',exports:'.'}),
  'packages/backend/lib/entry.js':`export {marker} from '@teloa/contract'`,
  'packages/backend/lib/fresh.js':`export {marker} from '@teloa/contract'`,
  'packages/backend/lib/unknown.js':`export {marker} from '@teloa/not-in-this-release'`,
 }
 for(const [path,text] of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text)}
 await writeFile(join(root,'release-manifest.json'),JSON.stringify({schema:'teloa.release/v1',version:'1.0.0',dshVersion:'0.2.1-rc.2',dataVersion:4,compatibleDataVersions:[4],files:Object.entries(files).map(([path,text])=>({path,sha256:hash(text)}))}));t.after(()=>rm(root,{recursive:true,force:true}));return root
}
test('发行模块按已验同root self exports解析；嵌套旧/新root隔离，finally撤销hook',async t=>{
 const a=await fixture(t,'old'),b=await fixture(t,'new'),entry='packages/backend/lib/entry.js'
 await withReleaseModule(a,entry,async value=>{assert.equal((value as {marker:string}).marker,'old');await withReleaseModule(b,entry,async next=>{assert.equal((next as {marker:string}).marker,'new')});await assert.rejects(import(pathToFileURL(join(b,'packages/backend/lib/fresh.js')).href),{code:'ERR_MODULE_NOT_FOUND'})})
 await assert.rejects(import(pathToFileURL(join(a,'packages/backend/lib/fresh.js')).href),{code:'ERR_MODULE_NOT_FOUND'})
})
test('回调失败也撤销hook；未知包、越界入口、清单变化与文件篡改均拒绝',async t=>{
 const a=await fixture(t,'failed')
 await assert.rejects(withReleaseModule(a,'packages/backend/lib/entry.js',async()=>{throw Error('callback stopped')}),/callback stopped/)
 await assert.rejects(import(pathToFileURL(join(a,'packages/backend/lib/fresh.js')).href),{code:'ERR_MODULE_NOT_FOUND'})
 await assert.rejects(withReleaseModule(a,'packages/backend/lib/unknown.js',async()=>undefined),/依赖归属/)
 await assert.rejects(withReleaseModule(a,'../escape.js',async()=>undefined),/依赖归属/)
 await writeFile(join(a,'packages/backend/lib/entry.js'),'export const marker="tampered"');await assert.rejects(withReleaseModule(a,'packages/backend/lib/entry.js',async()=>undefined),/依赖归属/)
 const b=await fixture(t,'manifest');await withReleaseModule(b,'packages/backend/lib/entry.js',async()=>undefined);await writeFile(join(b,'release-manifest.json'),(await readFile(join(b,'release-manifest.json'),'utf8'))+' ');await assert.rejects(withReleaseModule(b,'packages/backend/lib/entry.js',async()=>undefined),/依赖归属/)
})
