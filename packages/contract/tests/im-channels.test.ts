import test from 'node:test'
import assert from 'node:assert/strict'
import {
 imChannelKinds,imChannelErrorCodes,imCredentialFields,imChannelEndpoints,imChannelWriteEndpoints,
 imChannelSaveInput,imChannelIdInput,imBindingRemoveInput,imBindingChangeInput,imGroupBindInput,imGroupUnbindInput,
 readImChannelSummary,rejectSecretKeys,
 type ImChannelSummary,
} from '../src/im-channels.ts'
import {pendingRequestEndpoints,isPendingRequestEndpoint} from '../src/pending-requests.ts'

const requestId='16057272-ed9d-44a3-abe4-2ab04e056105'
const roleId='7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const groupId='0f9e8d7c-6b5a-4433-9211-0fedcba98765'
const invalid={code:'teloa/invalid-input'}

test('imChannelKinds 恰好四值且顺序固定（Lark 紧随飞书）',()=>{
 assert.deepEqual(imChannelKinds,['feishu','lark','telegram','slack'])
})

test('Lark 渠道：凭据键为 LARK_*（与飞书分开保存），LARK_ENCRYPT_KEY 可选；不接受飞书键或任意域名字段',()=>{
 assert.deepEqual(imCredentialFields.lark,[{key:'LARK_APP_ID',required:true},{key:'LARK_APP_SECRET',required:true},{key:'LARK_ENCRYPT_KEY',required:false}])
 const lark={requestId,channelId:'lark',kind:'lark',credentials:{LARK_APP_ID:'cli_0123456789abcdef',LARK_APP_SECRET:'TEST-lark-secret'}}
 assert.deepEqual(imChannelSaveInput(lark),lark)
 assert.throws(()=>imChannelSaveInput({...lark,credentials:{FEISHU_APP_ID:'cli_0123456789abcdef',FEISHU_APP_SECRET:'x'}}),invalid)
 assert.throws(()=>imChannelSaveInput({...lark,credentials:{...lark.credentials,LARK_DOMAIN:'https://evil.example'}}),invalid)
 assert.throws(()=>imChannelSaveInput({...lark,domain:'https://evil.example'}),invalid)
 assert.throws(()=>imChannelSaveInput({...lark,channelId:'feishu'}),invalid)
 assert.throws(()=>imChannelSaveInput({...lark,credentials:{LARK_APP_ID:'cli_0123456789abcdef'}}),invalid)
 assert.deepEqual(imChannelIdInput({requestId,channelId:'lark'}),{requestId,channelId:'lark'})
})

test('imChannelErrorCodes 含 app-id-unsupported（App ID 能保存但暂时无法建立长连接）',()=>{
 assert.ok((imChannelErrorCodes as readonly string[]).includes('app-id-unsupported'))
})

test('imCredentialFields 与规格 §5.3 表逐键一致，仅 FEISHU_ENCRYPT_KEY／LARK_ENCRYPT_KEY 可选',()=>{
 assert.deepEqual(imCredentialFields.telegram,[{key:'TELEGRAM_BOT_TOKEN',required:true}])
 assert.deepEqual(imCredentialFields.slack,[{key:'SLACK_BOT_TOKEN',required:true},{key:'SLACK_APP_TOKEN',required:true}])
 assert.deepEqual(imCredentialFields.feishu,[{key:'FEISHU_APP_ID',required:true},{key:'FEISHU_APP_SECRET',required:true},{key:'FEISHU_ENCRYPT_KEY',required:false}])
 for(const fields of Object.values(imCredentialFields))for(const {key} of fields)assert.match(key,/^[A-Z_][A-Z0-9_]*$/)
})

test('imChannelEndpoints 与 imChannelWriteEndpoints 无重复且写端点 ⊆ 全部端点',()=>{
 assert.equal(new Set(imChannelEndpoints).size,imChannelEndpoints.length)
 assert.equal(new Set(imChannelWriteEndpoints).size,imChannelWriteEndpoints.length)
 assert.equal(imChannelWriteEndpoints.length,9)
 for(const endpoint of imChannelWriteEndpoints)assert.ok((imChannelEndpoints as readonly string[]).includes(endpoint),endpoint)
 for(const endpoint of ['im/channels/list','im/bindings/list','im/groups/list'])assert.ok(!(imChannelWriteEndpoints as readonly string[]).includes(endpoint),endpoint)
})

test('pendingRequestEndpoints 含除 im/channels/save 外的 8 个 IM 写端点；携带凭据原值的 save 与三个 list 端点不在其中',()=>{
 for(const endpoint of imChannelWriteEndpoints)assert.equal(isPendingRequestEndpoint(endpoint),endpoint!=='im/channels/save',endpoint)
 assert.equal(isPendingRequestEndpoint('im/channels/save'),false,'凭据原值不得进入待恢复目录')
 for(const endpoint of ['im/channels/list','im/bindings/list','im/groups/list'])assert.equal(isPendingRequestEndpoint(endpoint),false,endpoint)
 assert.equal(new Set(pendingRequestEndpoints).size,pendingRequestEndpoints.length)
})

function saveInput(overrides:Record<string,unknown>={}):Record<string,unknown>{
 return {requestId,channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'123456:ABC-DEF'},...overrides}
}

test('imChannelSaveInput 合法 telegram 输入原样返回',()=>{
 assert.deepEqual(imChannelSaveInput(saveInput()),{requestId,channelId:'telegram',kind:'telegram',credentials:{TELEGRAM_BOT_TOKEN:'123456:ABC-DEF'}})
})

test('imChannelSaveInput 拒绝未知字段、channelId!==kind、非 uuid requestId、未知 kind',()=>{
 assert.throws(()=>imChannelSaveInput(saveInput({extra:1})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({channelId:'slack'})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({requestId:'not-a-uuid'})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({channelId:'wechat',kind:'wechat',credentials:{}})),invalid)
 assert.throws(()=>imChannelSaveInput({requestId,channelId:'telegram',kind:'telegram'}),invalid)
 assert.throws(()=>imChannelSaveInput(null),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:['TELEGRAM_BOT_TOKEN']})),invalid)
})

test('imChannelSaveInput 缺必填键：telegram 缺 TELEGRAM_BOT_TOKEN、slack 缺 SLACK_APP_TOKEN',()=>{
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({channelId:'slack',kind:'slack',credentials:{SLACK_BOT_TOKEN:'xoxb-1'}})),invalid)
 assert.deepEqual(imChannelSaveInput(saveInput({channelId:'slack',kind:'slack',credentials:{SLACK_BOT_TOKEN:'xoxb-1',SLACK_APP_TOKEN:'xapp-1'}})).credentials,{SLACK_BOT_TOKEN:'xoxb-1',SLACK_APP_TOKEN:'xapp-1'})
})

test('imChannelSaveInput 多余键：telegram 带 SLACK_BOT_TOKEN 拒绝',()=>{
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'t',SLACK_BOT_TOKEN:'xoxb-1'}})),invalid)
})

test('imChannelSaveInput 值含换行、空格、空串、513 字符、非字符串均拒绝；512 字符通过',()=>{
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'abc\ndef'}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'abc def'}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'abc\tdef'}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:''}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'a'.repeat(513)}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:123}})),invalid)
 assert.equal(imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'a'.repeat(512)}})).credentials.TELEGRAM_BOT_TOKEN?.length,512)
})

test('imChannelSaveInput 值含 NUL、零宽字符、其他控制字符拒绝',()=>{
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'abc\u0000def'}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'abc\u200bdef'}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'abc\u001bdef'}})),invalid)
 assert.throws(()=>imChannelSaveInput(saveInput({credentials:{TELEGRAM_BOT_TOKEN:'abc\u007fdef'}})),invalid)
})

test('imChannelSaveInput feishu：只填 APP_ID+APP_SECRET 通过；带 FEISHU_ENCRYPT_KEY 也通过；缺 APP_SECRET 拒绝',()=>{
 const base={requestId,channelId:'feishu',kind:'feishu'}
 assert.equal(imChannelSaveInput({...base,credentials:{FEISHU_APP_ID:'cli_x',FEISHU_APP_SECRET:'s'}}).kind,'feishu')
 assert.deepEqual(imChannelSaveInput({...base,credentials:{FEISHU_APP_ID:'cli_x',FEISHU_APP_SECRET:'s',FEISHU_ENCRYPT_KEY:'k'}}).credentials,{FEISHU_APP_ID:'cli_x',FEISHU_APP_SECRET:'s',FEISHU_ENCRYPT_KEY:'k'})
 assert.throws(()=>imChannelSaveInput({...base,credentials:{FEISHU_APP_ID:'cli_x',FEISHU_ENCRYPT_KEY:'k'}}),invalid)
})

test('imChannelIdInput 恰好两键，channelId 只认三渠道',()=>{
 assert.deepEqual(imChannelIdInput({requestId,channelId:'slack'}),{requestId,channelId:'slack'})
 assert.throws(()=>imChannelIdInput({requestId,channelId:'slack',kind:'slack'}),invalid)
 assert.throws(()=>imChannelIdInput({requestId,channelId:'wechat'}),invalid)
 assert.throws(()=>imChannelIdInput({requestId}),invalid)
 assert.throws(()=>imChannelIdInput({requestId:'x',channelId:'slack'}),invalid)
})

test('imBindingRemoveInput：imUserId 1..128 可见字符',()=>{
 assert.deepEqual(imBindingRemoveInput({requestId,channelId:'telegram',imUserId:'12345'}),{requestId,channelId:'telegram',imUserId:'12345'})
 assert.equal(imBindingRemoveInput({requestId,channelId:'telegram',imUserId:'u'.repeat(128)}).imUserId.length,128)
 assert.throws(()=>imBindingRemoveInput({requestId,channelId:'telegram',imUserId:''}),invalid)
 assert.throws(()=>imBindingRemoveInput({requestId,channelId:'telegram',imUserId:'u'.repeat(129)}),invalid)
 assert.throws(()=>imBindingRemoveInput({requestId,channelId:'telegram',imUserId:'a b'}),invalid)
 assert.throws(()=>imBindingRemoveInput({requestId,channelId:'telegram',imUserId:'a\u0000b'}),invalid)
 assert.throws(()=>imBindingRemoveInput({requestId,channelId:'telegram',imUserId:'x',extra:1}),invalid)
})

test('imBindingChangeInput：assistant 精确一键；role 须带 uuid roleId；缺/多字段拒绝',()=>{
 assert.deepEqual(imBindingChangeInput({requestId,channelId:'telegram',imUserId:'u1',target:{kind:'assistant'}}).target,{kind:'assistant'})
 assert.deepEqual(imBindingChangeInput({requestId,channelId:'telegram',imUserId:'u1',target:{kind:'role',roleId}}).target,{kind:'role',roleId})
 assert.throws(()=>imBindingChangeInput({requestId,channelId:'telegram',imUserId:'u1',target:{kind:'role'}}),invalid)
 assert.throws(()=>imBindingChangeInput({requestId,channelId:'telegram',imUserId:'u1',target:{kind:'role',roleId:'not-uuid'}}),invalid)
 assert.throws(()=>imBindingChangeInput({requestId,channelId:'telegram',imUserId:'u1',target:{kind:'assistant',roleId}}),invalid)
 assert.throws(()=>imBindingChangeInput({requestId,channelId:'telegram',imUserId:'u1',target:{kind:'group'}}),invalid)
 assert.throws(()=>imBindingChangeInput({requestId,channelId:'telegram',imUserId:'u1'}),invalid)
})

test('imGroupBindInput / imGroupUnbindInput：groupId uuid，chatId 1..128 可见字符',()=>{
 assert.deepEqual(imGroupBindInput({requestId,channelId:'feishu',chatId:'oc_1',groupId}),{requestId,channelId:'feishu',chatId:'oc_1',groupId})
 assert.throws(()=>imGroupBindInput({requestId,channelId:'feishu',chatId:'oc_1',groupId:'g1'}),invalid)
 assert.throws(()=>imGroupBindInput({requestId,channelId:'feishu',chatId:'',groupId}),invalid)
 assert.throws(()=>imGroupBindInput({requestId,channelId:'feishu',chatId:'c'.repeat(129),groupId}),invalid)
 assert.throws(()=>imGroupBindInput({requestId,channelId:'feishu',chatId:'oc 1',groupId}),invalid)
 assert.deepEqual(imGroupUnbindInput({requestId,channelId:'feishu',chatId:'oc_1'}),{requestId,channelId:'feishu',chatId:'oc_1'})
 assert.throws(()=>imGroupUnbindInput({requestId,channelId:'feishu',chatId:'oc_1',groupId}),invalid)
})

function summary(overrides:Record<string,unknown>={}):Record<string,unknown>{
 const base:ImChannelSummary={channelId:'telegram',kind:'telegram',label:'Telegram',enabled:true,credentialsSaved:true,status:{connected:true,lastEventAt:'2026-09-25T00:00:00.000Z'},bindings:1,groups:0}
 return {...base,...overrides}
}

test('readImChannelSummary 合法回包原样返回；status 可只含 connected',()=>{
 assert.deepEqual(readImChannelSummary(summary()),summary())
 assert.deepEqual(readImChannelSummary(summary({status:{connected:false,error:'another-host'}})).status,{connected:false,error:'another-host'})
 assert.deepEqual(readImChannelSummary(summary({status:{connected:false}})).status,{connected:false})
})

test('readImChannelSummary 多字段、缺字段、类型错误均 throw',()=>{
 assert.throws(()=>readImChannelSummary({...summary(),extra:1}),invalid)
 const {groups:_groups,...missing}=summary()
 assert.throws(()=>readImChannelSummary(missing),invalid)
 assert.throws(()=>readImChannelSummary(summary({kind:'wechat'})),invalid)
 assert.throws(()=>readImChannelSummary(summary({enabled:'true'})),invalid)
 assert.throws(()=>readImChannelSummary(summary({bindings:-1})),invalid)
 assert.throws(()=>readImChannelSummary(summary({label:''})),invalid)
 assert.throws(()=>readImChannelSummary(summary({status:{connected:'yes'}})),invalid)
 assert.throws(()=>readImChannelSummary(summary({status:{connected:true,lastEventAt:'not-a-date'}})),invalid)
 assert.throws(()=>readImChannelSummary(summary({status:{connected:true,extra:1}})),invalid)
})

test('L4 readImChannelSummary status.error 只认稳定错误码：每个码通过；适配器原文、未知码 throw',()=>{
 for(const code of imChannelErrorCodes)assert.equal(readImChannelSummary(summary({status:{connected:false,error:code}})).status.error,code)
 for(const error of ['另一宿主已连接','连接 Slack 连续失败 10 次，仍在重试','e'.repeat(8),''])assert.throws(()=>readImChannelSummary(summary({status:{connected:false,error}})),invalid)
})

test('readImChannelSummary 读侧防回显：任何以 TOKEN/SECRET/KEY 结尾的键（含嵌套在 status 内）都 throw',()=>{
 assert.throws(()=>readImChannelSummary({...summary(),TELEGRAM_BOT_TOKEN:'123456:ABC'}),invalid)
 assert.throws(()=>readImChannelSummary({...summary(),FEISHU_APP_SECRET:'s'}),invalid)
 assert.throws(()=>readImChannelSummary({...summary(),FEISHU_ENCRYPT_KEY:'k'}),invalid)
 assert.throws(()=>readImChannelSummary(summary({status:{connected:true,SLACK_APP_TOKEN:'xapp'}})),invalid)
 const {groups:_groups,...withoutGroups}=summary()
 assert.throws(()=>readImChannelSummary({...withoutGroups,apiKey:'k'}),invalid)
})

test('rejectSecretKeys 导出且下钻数组：列表内任一行带凭据键即 throw，正常列表不抛',()=>{
 assert.doesNotThrow(()=>rejectSecretKeys([{channelId:'telegram',imUserId:'u1',target:{kind:'assistant'}}]))
 assert.throws(()=>rejectSecretKeys([{channelId:'telegram'},{channelId:'slack',SLACK_BOT_TOKEN:'x'}]),invalid)
 assert.throws(()=>rejectSecretKeys({rows:[[{apiKey:'k'}]]}),invalid)
})

test('验收桩 stub：不在 imChannelKinds（正式三值），契约层认得 STUB_TOKEN 保存与读侧摘要（宿主另按环境拒绝）',()=>{
 assert.equal((imChannelKinds as readonly string[]).includes('stub'),false)
 assert.deepEqual(imCredentialFields.stub,[{key:'STUB_TOKEN',required:true}])
 assert.deepEqual(imChannelSaveInput({requestId,channelId:'stub',kind:'stub',credentials:{STUB_TOKEN:'stub-secret-9f3a'}}),{requestId,channelId:'stub',kind:'stub',credentials:{STUB_TOKEN:'stub-secret-9f3a'}})
 assert.throws(()=>imChannelSaveInput({requestId,channelId:'stub',kind:'stub',credentials:{}}),invalid)
 assert.equal(readImChannelSummary({channelId:'stub',kind:'stub',label:'验收桩',enabled:false,credentialsSaved:true,status:{connected:false},bindings:0,groups:0}).kind,'stub')
})
