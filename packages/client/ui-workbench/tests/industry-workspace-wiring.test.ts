import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const [capabilities,presentation,business,frame]=await Promise.all([
 readFile(new URL('../src/client/TeamCapabilitiesPage.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/team-capabilities-presentation.ts',import.meta.url),'utf8'),
 readFile(new URL('../src/client/BusinessPage.tsx',import.meta.url),'utf8'),
 readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),
])

test('团队能力只把行业 Skill、MCP 登记投影到正式目录并明确未可用',()=>{
 assert.match(capabilities,/industryLoads/)
 assert.match(capabilities,/projectIndustryWorkspace\(industryLoads,\{destination:'team-capability'\}\)/)
 assert.match(capabilities,/teamCapabilityCatalog\(snapshot\?\{snapshot,industryResources\}:\{industryResources\}\)/)
 assert.match(capabilities,/teamCapability\.field\.templateVersion/)
 assert.match(capabilities,/teamCapability\.registered\.notice/)
 assert.match(presentation,/from '\.\/industry-workspace-projection\.js'/)
 assert.doesNotMatch(presentation,/industry-workspace-projection\.ts/)
 assert.doesNotMatch(presentation,/resource\.kind==='plugin'/)
})

test('业务空间数据页和执行页各自呈现真实加载声明',()=>{
 assert.match(business,/projectIndustryWorkspace/)
 assert.match(business,/workspaceResources\.filter\(row=>row\.destination==='business-data'\)/)
 assert.match(business,/workspaceResources\.filter\(row=>row\.destination==='business-execution'\)/)
 assert.match(business,/label=\{t\('business\.industry\.loadedDataSourceDeclarations'\)\}/)
 assert.match(business,/label=\{t\('business\.industry\.loadedExecutionToolDeclarations'\)\}/)
 assert.match(business,/t\('business\.industry\.resourceInstance'\)/)
})

test('工作台把同一真实加载目录传给团队能力和业务空间',()=>{
 assert.match(frame,/<TeamCapabilitiesPage\b/)
 assert.match(frame,/<BusinessPage\b/)
 assert.equal(frame.match(/industryLoads=\{savedIndustryLoads\}/g)?.length,2)
})

test('业务概览先呈现真实状态与能力绑定，模板来源只保留紧凑摘要',()=>{
 const businessLine=frame.split('\n').find(line=>line.includes('<BusinessPage'))??''
 assert.doesNotMatch(businessLine,/industryResources\(\{scope\}\)/)
 assert.match(businessLine,/capabilities=\{scope=><CapabilityTargetPanel/)
 assert.doesNotMatch(business,/summarizeIndustryWorkspace/)
 assert.match(business,/t\('business\.industry\.sourceAndPinnedVersion'\)/)
 assert.doesNotMatch(business,/summary\.map\(/)
 assert.match(business,/aria-label=\{t\('business\.capabilities\.bindingsAria'\)\}/)
 assert.doesNotMatch(business,/business\.capabilities\.workEnvironmentAria/)
})

test('业务空间行业声明和来源摘要始终经当前语言词典呈现',()=>{
 assert.doesNotMatch(business,/const industryDestinationLabelKeys=/)
 assert.doesNotMatch(business,/const industryDestinationStateKeys=/)
 assert.match(business,/const industryReadinessKeys=/)
 assert.match(business,/t\(industryReadinessKeys\[row\.kind\]\)/)
 assert.doesNotMatch(business,/\{row\.(?:label|pending|readiness)\}/)
})
