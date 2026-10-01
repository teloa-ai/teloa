import test from 'node:test'
import assert from 'node:assert/strict'
import {IM_CHANNELS_MESSAGE_ROWS} from '../src/client/i18n/locales/im-channels.ts'
// 聚合词表读构建产物（源码按 .js 互引）；改词条后需先 build。
const {CORE_PAGE_MESSAGE_ROWS,corePageMessages}=await import('../lib/types/client/i18n/locales/core-pages.js') as {CORE_PAGE_MESSAGE_ROWS:ReadonlyArray<readonly string[]>;corePageMessages:Record<string,Record<string,string>>}

const locales=['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt'] as const

test('IM 通道词表十一列齐全、键唯一且在 imChannels.* 下，简体中文无禁词',()=>{
 assert.ok(IM_CHANNELS_MESSAGE_ROWS.length>=40)
 const forbidden=/工作空间|单空间|实例|投影|尚未加载|内容待读取|人类/
 const keys=new Set<string>()
 for(const row of IM_CHANNELS_MESSAGE_ROWS){
  assert.equal(row.length,11,row[0])
  assert.match(row[0],/^imChannels\./)
  assert.equal(keys.has(row[0]),false,row[0])
  keys.add(row[0])
  assert.ok(row.slice(1).every(value=>value.trim().length>0),row[0])
  assert.doesNotMatch(row[1],forbidden,row[0])
 }
 for(const key of ['imChannels.title','imChannels.saved','imChannels.status.connected','imChannels.status.disconnected','imChannels.status.error','imChannels.status.disabled','imChannels.pairing.create','imChannels.pairing.hint','imChannels.pairing.expiresIn','imChannels.pairing.expired','imChannels.target.assistant','imChannels.limits.workbenchCard','imChannels.limits.restart','imChannels.error.generic'])assert.ok(keys.has(key),key)
 for(const code of ['appIdUnsupported','anotherHost','credentialsInvalid','credentialsMissing','reconnecting','sdkMissing','sdkInstallFailed','startFailed','unknown'])assert.ok(keys.has(`imChannels.statusError.${code}`),code)
 for(const field of ['TELEGRAM_BOT_TOKEN','SLACK_BOT_TOKEN','SLACK_APP_TOKEN','FEISHU_APP_ID','FEISHU_APP_SECRET','FEISHU_ENCRYPT_KEY'])assert.ok(keys.has(`imChannels.field.${field}`),field)
 for(const key of ['imChannels.kind.lark','imChannels.larkSetup','imChannels.larkInstall','imChannels.larkInstallFailed','imChannels.appIdInUse'])assert.ok(keys.has(key),key)
})

test('IM 通道词条接入核心词典：每个键恰出现一次，十种语言都有译文',()=>{
 for(const [key] of IM_CHANNELS_MESSAGE_ROWS){
  assert.equal(CORE_PAGE_MESSAGE_ROWS.filter(row=>row[0]===key).length,1,key)
  for(const locale of locales)assert.ok(corePageMessages[locale]![key]?.trim(),`${locale} ${key}`)
 }
})

test('Lark 渠道名十种语言都写明是飞书国际版，且都以 Lark 开头',()=>{
 const row=IM_CHANNELS_MESSAGE_ROWS.find(item=>item[0]==='imChannels.kind.lark')!
 assert.deepEqual(row.slice(1),['Lark（飞书国际版）','Lark（飛書國際版）','Lark (Feishu international)','Lark（Feishu 国際版）','Lark(Feishu 국제판)','Lark (Feishu quốc tế)','Lark (Feishu internacional)','Lark (Feishu international)','Lark (internationales Feishu)','Lark (Feishu internacional)'])
 const description=IM_CHANNELS_MESSAGE_ROWS.find(item=>item[0]==='imChannels.description')!
 assert.ok(description.slice(1).every(value=>value.includes('Lark')))
})

test('SDK 是行业通用叫法：开发包相关状态提示保留「SDK」，并写明飞书/Lark 共用',()=>{
 for(const key of ['imChannels.statusError.sdkMissing','imChannels.statusError.sdkInstallFailed']){
  const row=IM_CHANNELS_MESSAGE_ROWS.find(item=>item[0]===key)!
  for(const value of row.slice(1))assert.match(value,/SDK/,`${key}: ${value}`)
  assert.match(row[1],/飞书\/Lark SDK/)
 }
})
