// 白话守卫的第二道：界面词条之外，宿主确认卡与拒绝理由、客户端中文兜底文案同样不能带回工程术语。
// 禁词表与豁免理由共用 tests/plain-language-jargon.mjs；只扫字符串字面量里的文案，不扫字段名、错误码等机器标识。
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {plainLanguageJargon} from './plain-language-jargon.mjs'

const root=new URL('../',import.meta.url)
const read=path=>readFileSync(new URL(path,root),'utf8')
const cjk=/[\u4e00-\u9fff]/
/** 取出源码中的字符串与模板字面量（不展开 ${} 插值），只保留含中文的文案。 */
const literals=source=>[...source.matchAll(/(['`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map(match=>match[2]).filter(text=>cjk.test(text))

const userFacingSources=[
  // 会话确认卡、拒绝理由与工具说明（模型会原样复述给用户）
  'packages/harness-dsh/src/market-session-tools.ts',
  'packages/harness-dsh/src/skill-install-tools.ts',
  'packages/harness-dsh/src/skill-http-tool.ts',
  'packages/harness-dsh/src/skill-secrets.ts',
  'packages/harness-dsh/src/business-definition-tools.ts',
  'packages/harness-dsh/src/credential-guards.ts',
  'packages/harness-dsh/src/skill-secret-hint.ts',
  'packages/harness-dsh/src/task-tool-guard.ts',
  // IM 渠道状态与报错（设置页直接显示）
  'packages/im-gateway/src/channels/feishu-sdk.ts',
  'packages/im-gateway/src/channels/index.ts',
  // 经宿主拒绝理由显示到会话里的后端报错
  'packages/backend/src/market/skill-installations.ts',
  'packages/backend/src/work/business-definition-local.ts',
  // 客户端没有词条时直接显示的中文兜底文案
  'packages/client/ui-workbench/src/client/market-preview.ts',
  'packages/client/ui-workbench/src/client/task-detail-presentation.ts',
  'packages/client/ui-workbench/src/client/team-presentation.ts',
  'packages/client/ui-workbench/src/client/skill-secrets-api.ts',
]

/** 逐条豁免（文件 → 整个字面量 → 理由）：只放行「旧说法作为查找键、界面显示替换后白话」的映射表。 */
const literalExemptions={
  'packages/client/ui-workbench/src/client/market-preview.ts':{'；上游 ':'官方目录审核说明原文进 trustHash 不能改存储，展示层把「上游」换成「原作者」；这里是替换的查找键，界面不显示','研究与协作岗位':'内置演示模板里一位同事的职位名称（与 builtin-industry-manifests 同名），职位义，不是把同事叫作岗位'},
}

test('宿主确认卡、拒绝理由与客户端兜底文案不带工程术语',()=>{
  const hits=[]
  for(const path of userFacingSources)for(const text of literals(read(path)))if(plainLanguageJargon['zh-CN'].test(text)&&!Object.hasOwn(literalExemptions[path]??{},text))hits.push(`${path}: ${text.slice(0,120)}`)
  assert.deepEqual(hits,[])
})


test('扫描能拦住旧确认卡写法',()=>{
  for(const sample of ['许可 MIT，指纹 abc','按正文声明它会访问','上游 https://example.com','固定 bundleHash：abc','业务声明草案回执与本次请求不一致。','确认添加并安装到当前宿主？','凭据存储已锁定','下载运行时','Skill 锁定来源的摘要已变化。','随 Teloa 发行','记录镜像摘要','确认添加并安装 Skill“x”？','该连接器已添加','DSH 插件安装服务不可用。','岗位目录返回格式不正确。','当前会话没有可核验的在运行数字员工。'])assert.match(sample,plainLanguageJargon['zh-CN'],sample)
  for(const sample of ['Multiple Harnesses','the harness'])assert.match(sample,plainLanguageJargon.en,sample)
  assert.doesNotMatch('DeepSeek Harness',plainLanguageJargon.en)
  for(const sample of ['确认添加并安装技能“x”？','未找到 SKILL.md，无法作为技能添加。','通用岗位','按「x」的岗位身份回答','起草岗位职责说明书','连接器件与线缆'])assert.doesNotMatch(sample,plainLanguageJargon['zh-CN'],sample)
  assert.deepEqual(literals("const a='确认卡：指纹 x',b=`上游 ${url}`"),['确认卡：指纹 x','上游 ${url}'])
})

