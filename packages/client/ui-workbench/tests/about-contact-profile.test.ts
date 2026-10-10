import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'tsdown'
import {clientBundle} from '../../tsdown.preset.ts'
import {aboutContactBuildProfile} from '../about-contact-profile.ts'

test('正式商业联系构建没有开发者姓名、微信身份或四张个人二维码，社区构建保留',async()=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),temp=await mkdtemp(join(tmpdir(),'teloa-contact-profile-'))
 try{
  for(const profile of ['official','community'] as const){
   const config=clientBundle('@teloa/client-ui-workbench','src/client/AboutSettings.tsx')[1]!
   await build({...config,config:false,cwd:root,outDir:join(temp,profile),sourcemap:false,logLevel:'error',define:{__TELOA_VERSION__:'"test"'},alias:aboutContactBuildProfile(profile).alias})
   const bytes=await readFile(join(temp,profile,'client.js'),'utf8')
   const personal=/Max Luo|Morgan Chen|Caleb Pan|neteyes|白帽子罗棋琛|github\.com\/teloa-ai\//
   const images=[...bytes.matchAll(/data:image\/jpeg;base64,/g)]
   if(profile==='official'){
    assert.doesNotMatch(bytes,personal);assert.equal(images.length,0)
    assert.match(bytes,/support@teloa\.ai/);assert.match(bytes,/hi@teloa\.ai/);assert.match(bytes,/https:\/\/teloa\.ai/)
   }else{assert.match(bytes,personal);assert.equal(images.length,4)}
  }
  assert.throws(()=>aboutContactBuildProfile('invalid'),/联系构建/)
 }finally{await rm(temp,{recursive:true,force:true})}
})
