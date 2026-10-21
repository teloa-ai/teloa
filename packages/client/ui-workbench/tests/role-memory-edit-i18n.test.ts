import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import {TEAM_DETAIL_MESSAGE_ROWS} from '../src/client/i18n/locales/team-details.ts'

test('本人记忆编辑简繁英词条进入实际目录，地区回退可用',async()=>{
 const entry=fileURLToPath(new URL('../src/client/i18n/messages.ts',import.meta.url)),built=await build({configFile:false,logLevel:'error',build:{write:false,minify:false,lib:{entry,formats:['es']}}}),bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output'in bundle)
 const chunk=bundle.output.find(item=>item.type==='chunk')!
 const {translateMessage}=await import('data:text/javascript;base64,'+Buffer.from(chunk.code).toString('base64'))
 for(const row of TEAM_DETAIL_MESSAGE_ROWS.filter(row=>row[0].startsWith('roleMemory.edit.'))){
  for(const [locale,index] of [['zh-CN',1],['zh-Hant',2],['zh-TW',2],['zh-HK',2],['en',3]] as const){
   const translated=translateMessage(locale,row[0] as never,{version:2,title:'原来源'})
   assert.ok(translated&&translated!==row[0]);assert.equal(translated,row[index].replace('{version}','2').replace('{title}','原来源'))
  }
 }
})
