import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readIndustryDataSourceDefinition,readIndustryMcpConnectionDefinition,readIndustryPluginDefinition,mcpToolFullName} from '../src/industry-definitions.ts'

test('数据源定义只接受固定格式、合法 sourceId 与非空去重 scopes',()=>{
 assert.deepEqual(readIndustryDataSourceDefinition({format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC']}),{format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC']})
 for(const bad of [
  {format:'teloa.data-source/v2',sourceId:'a',scopes:['SOC']},
  {format:'teloa.data-source/v1',sourceId:'-bad',scopes:['SOC']},
  {format:'teloa.data-source/v1',sourceId:'a',scopes:[]},
  {format:'teloa.data-source/v1',sourceId:'a',scopes:['SOC','SOC']},
  {format:'teloa.data-source/v1',sourceId:'a',scopes:['general']},
  {format:'teloa.data-source/v1',sourceId:'a',scopes:['x'.repeat(121)]},
  {format:'teloa.data-source/v1',sourceId:'a',scopes:['SOC'],extra:1},
  null,[],'x',
 ])assert.throws(()=>readIndustryDataSourceDefinition(bad),{code:'teloa/invalid-input'})
})

test('来源名词可缺省：不带这一位的旧模板仍然合法，带的时候原样保留',()=>{
 // 向后兼容：缺这一位读出来也不凭空补一个默认值，回落交给界面那一层。
 assert.ok(!('sourceNoun' in readIndustryDataSourceDefinition({format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC']})))
 assert.deepEqual(
  readIndustryDataSourceDefinition({format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC'],sourceNoun:'告警源'}),
  {format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC'],sourceNoun:'告警源'},
 )
 assert.equal(readIndustryDataSourceDefinition({format:'teloa.data-source/v1',sourceId:'a',scopes:['AppSec'],sourceNoun:'代码仓库'}).sourceNoun,'代码仓库')
 // 十二字整好，十三字不成立。
 assert.equal(readIndustryDataSourceDefinition({format:'teloa.data-source/v1',sourceId:'a',scopes:['SOC'],sourceNoun:'十'.repeat(12)}).sourceNoun,'十'.repeat(12))
 for(const noun of ['','   ',' 告警源','告警源 ','十'.repeat(13),'告警\n源','告警\t源','告警\r源','告警\x00源','告警\x7f源',42,null,{}])
  assert.throws(()=>readIndustryDataSourceDefinition({format:'teloa.data-source/v1',sourceId:'a',scopes:['SOC'],sourceNoun:noun}),{code:'teloa/invalid-input'},String(noun))
})

test('MCP 连接定义校验 serverName 与工具名并拼出完整工具名',()=>{
 assert.deepEqual(readIndustryMcpConnectionDefinition({format:'teloa.mcp-connection/v1',serverName:'teloa_reference',tools:['read_reference']}),{format:'teloa.mcp-connection/v1',serverName:'teloa_reference',tools:['read_reference']})
 assert.equal(mcpToolFullName('teloa_reference','read_reference'),'mcp__teloa_reference__read_reference')
 for(const bad of [
  {format:'teloa.mcp-connection/v1',serverName:'a'.repeat(33),tools:['x']},
  {format:'teloa.mcp-connection/v1',serverName:'has space',tools:['x']},
  // 服务名含 `__` 时 `mcp__a__b__c` 可对上别的服务器命名空间里原始名含 `__` 的工具
  {format:'teloa.mcp-connection/v1',serverName:'x__y',tools:['x']},
  {format:'teloa.mcp-connection/v1',serverName:'ok',tools:[]},
  {format:'teloa.mcp-connection/v1',serverName:'ok',tools:['x','x']},
  {format:'teloa.mcp-connection/v1',serverName:'ok',tools:['bad name']},
  {format:'teloa.mcp-connection/v1',serverName:'ok',tools:['x'.repeat(65)]},
  {format:'teloa.mcp-connection/v1',serverName:'ok',tools:['x'],url:'http://x'},
 ])assert.throws(()=>readIndustryMcpConnectionDefinition(bad),{code:'teloa/invalid-input'})
})

test('MCP 工具名允许点号，完整工具名按 DSH 公开名规则归一化（非法字符换下划线并追加身份摘要）',()=>{
 // 飞书官方 MCP 的工具名形如 im.v1.message.list；DSH 只接受 [A-Za-z0-9_-]{1,64}，越界时追加 sha256(server\0raw) 前 12 位。
 assert.deepEqual(readIndustryMcpConnectionDefinition({format:'teloa.mcp-connection/v1',serverName:'lark',tools:['im.v1.message.list','docx.v1.document.get']}).tools,['im.v1.message.list','docx.v1.document.get'])
 const suffix=(server:string,raw:string)=>createHash('sha256').update(server+'\0'+raw).digest('hex').slice(0,12)
 assert.equal(mcpToolFullName('lark','im.v1.message.list'),'mcp__lark__im_v1_message_list_'+suffix('lark','im.v1.message.list'))
 const long='a'.repeat(60)
 assert.equal(mcpToolFullName('dingtalk',long),('mcp__dingtalk__'+long).slice(0,51)+'_'+suffix('dingtalk',long))
 assert.equal(mcpToolFullName('dingtalk','send_robot_message'),'mcp__dingtalk__send_robot_message')
 const read=(tool:string)=>readIndustryMcpConnectionDefinition({format:'teloa.mcp-connection/v1',serverName:'ok',tools:[tool]}).tools[0]
 for(const good of ['a','a.b','a-b_c.d','x'.repeat(64),'v'+'.x'.repeat(31)+'y'])assert.equal(read(good),good)
 for(const bad of ['.leading','trailing.','a..b','has space','.','x'.repeat(65),'im/v1','工具'])assert.throws(()=>readIndustryMcpConnectionDefinition({format:'teloa.mcp-connection/v1',serverName:'ok',tools:[bad]}),{code:'teloa/invalid-input'},bad)
})

test('插件定义只接受 npm 精确版本',()=>{
 assert.deepEqual(readIndustryPluginDefinition({format:'teloa.plugin/v1',registry:'npm',packageName:'dsh-visualize',version:'0.1.2'}),{format:'teloa.plugin/v1',registry:'npm',packageName:'dsh-visualize',version:'0.1.2'})
 assert.equal(readIndustryPluginDefinition({format:'teloa.plugin/v1',registry:'npm',packageName:'@scope/name',version:'1.0.0-rc.1'}).packageName,'@scope/name')
 for(const bad of [
  {format:'teloa.plugin/v1',registry:'github',packageName:'a',version:'1.0.0'},
  {format:'teloa.plugin/v1',registry:'npm',packageName:'A',version:'1.0.0'},
  {format:'teloa.plugin/v1',registry:'npm',packageName:'a',version:'^1.0.0'},
  {format:'teloa.plugin/v1',registry:'npm',packageName:'a',version:'latest'},
  {format:'teloa.plugin/v1',registry:'npm',packageName:'a',version:'1.0.0',url:'x'},
 ])assert.throws(()=>readIndustryPluginDefinition(bad),{code:'teloa/invalid-input'})
})
