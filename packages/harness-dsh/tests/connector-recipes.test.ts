import test from 'node:test'
import assert from 'node:assert/strict'
import {readdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {readMarketCatalogEntry,type MarketCatalogConnectorEntry} from '@teloa/contract'

// 离线核对：目录连接器配方须与核对记录（tests/fixtures/public-market/reviews/connectors/*.json）逐项一致。
// 核对记录来自 npm pack 解包读源码或官方文档 / 公开元数据；本用例不联网，只防目录写错或悄悄漂移。
const marketplace=fileURLToPath(new URL('../../../tests/fixtures/public-market/',import.meta.url))
type Review={recipe:Record<string,unknown>;auth:{kind:string;supported?:boolean;slots?:string[];scopes?:string[]};upstreamTools:Record<string,'read'|'write'>}
// 兼容旧的按日期聚合文件（2026-09-26.json）与新的每条目一文件（<id>.json）：读取全部 *.json 合并 entries，同一 ID 出现在多个文件即失败
const reviewFiles=readdirSync(join(marketplace,'reviews/connectors')).filter(name=>name.endsWith('.json')).sort()
const review={format:'teloa.connector-recipe-review/v1',entries:{} as Record<string,Review>}
for(const name of reviewFiles){
 const file=JSON.parse(readFileSync(join(marketplace,'reviews/connectors',name),'utf8')) as {format:string;entries:Record<string,Review>}
 assert.equal(file.format,review.format,name)
 for(const [id,record] of Object.entries(file.entries)){assert.ok(!(id in review.entries),`${id} 在多个核对记录文件里`);review.entries[id]=record}
}
const connectors=readdirSync(join(marketplace,'catalog/connectors')).filter(name=>name.endsWith('.json'))
 .map(name=>readMarketCatalogEntry(JSON.parse(readFileSync(join(marketplace,'catalog/connectors',name),'utf8'))))
 .filter((entry):entry is MarketCatalogConnectorEntry=>entry.kind==='connector')

const slots=(auth:MarketCatalogConnectorEntry['connector']['auth'])=>auth.kind==='secret'?auth.vars.map(v=>v.target==='env'?'env:'+v.envVarName:v.target):[]

test('每个目录连接器都有核对记录，核对记录里没有目录外的条目',()=>{
 assert.ok(reviewFiles.length>0,'缺少核对记录文件')
 assert.deepEqual(connectors.map(entry=>entry.id).sort(),Object.keys(review.entries).sort())
})

for(const entry of connectors){
 test(`${entry.id}：配方与实装包一致（启动参数、凭据槽、声明工具存在且读写标注一致）`,()=>{
  const expected=review.entries[entry.id]
  assert.ok(expected,'缺少核对记录')
  const {recipe,auth,tools}=entry.connector
  assert.deepEqual(recipe,expected.recipe)
  assert.equal(auth.kind,expected.auth.kind)
  if(auth.kind==='oauth'){
   assert.equal(auth.supported,expected.auth.supported)
   if(auth.supported)assert.deepEqual(auth.scopes,expected.auth.scopes)
  }else assert.deepEqual(slots(auth),expected.auth.slots)
  for(const tool of tools){
   const kind:'read'|'write'|undefined=expected.upstreamTools[tool.name]
   assert.ok(kind,`声明的工具 ${tool.name} 不在上游按本配方注册的工具里`)
   assert.equal(tool.readOnly,kind==='read',`工具 ${tool.name} 的 readOnly 与上游读写性质不符`)
  }
 })
}

test('PostHog 的 exec 标只读只靠服务端只读会话：配方必须强制 readonly=true 与 tools 白名单，缺一即不能标只读',()=>{
 // exec 在上游 readOnlyHint:false，是通用执行入口；只有 readonly=true 时服务端才只留读工具（官方 FAQ）
 const posthog=connectors.find(entry=>entry.id==='teloa.mcp-posthog')
 assert.ok(posthog&&posthog.connector.recipe.transport==='streamable-http')
 const url=new URL(posthog.connector.recipe.url)
 assert.equal(url.searchParams.get('readonly'),'true')
 assert.deepEqual(url.searchParams.get('tools')?.split(','),['insight-query','projects-get','read-data-schema'])
 assert.deepEqual(posthog.connector.tools.map(tool=>[tool.name,tool.readOnly]),[['exec',true]])
})
