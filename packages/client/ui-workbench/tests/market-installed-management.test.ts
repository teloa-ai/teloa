import assert from 'node:assert/strict'
import test from 'node:test'
import {readFile,readdir} from 'node:fs/promises'

// BIZ-006 / UI-012：已安装的市场资源、员工包、技能要能从「已添加 / 我的应用与技能」进入真实管理，
// 并且只调用宿主已有端点；没有后端能力（技能硬卸载）时明确边界，不新增假 API。
const clientDir=new URL('../src/client/',import.meta.url)
const source=(name:string)=>readFile(new URL(name,clientDir),'utf8')
const locale=(name:string)=>readFile(new URL('i18n/locales/'+name,clientDir),'utf8')

test('已安装技能详情给出管理入口，进入真实版本/升级管理而不是只核对可用性',async()=>{
 const market=await source('MarketPage.tsx')
 assert.match(market,/<SkillInstallControl key=\{'atomic-'/,'技能详情保留安装状态')
 assert.match(market,/'skill:'\+/,'管理入口沿用既有技能安装详情选择键')
 assert.match(market,/'skill:directory'/,'拿不到安装身份时回落到技能安装目录')
 assert.match(market,/presentation\.installationId/,'管理入口优先打开本次安装的真实记录')
 const installations=await source('RealSkillInstallations.tsx')
 assert.match(installations,/<SkillUpgradePanel api=\{upgradeApi\}/,'安装详情接入真实升级面板')
 const pageRows=await locale('market-page.ts')
 assert.match(pageRows,/'market\.skill\.manageInstalled','管理已安装技能','管理已安裝技能','Manage installed skill'/,'缺少技能管理词条（简繁英定稿）')
 const upgrade=await source('skill-upgrade-api.ts')
 assert.match(upgrade,/skill-upgrades\/preview/,'升级预览调用真实端点')
 assert.match(upgrade,/skill-selections\/change/,'升级落地调用真实选择变更端点')
})

test('已添加页签按已加载版本给出管理入口，更新与卸载进入真实加载详情',async()=>{
 const market=await source('MarketPage.tsx')
 assert.match(market,/solutionListRows\(addedSolutions\)/,'已添加页签保留原有已添加内容')
 assert.match(market,/market\.solution\.manageLoaded/,'已添加页签给出「管理已加载内容」入口')
 assert.match(market,/props\.manageIndustryLoad\(load\.id\)/,'入口调用真实加载管理动作')
 assert.match(market,/load\.templateVersion/,'列表显示当前已加载版本')
 assert.match(market,/market\.solution\.catalogNewerVersion/,'目录有新版本时明确提示')
 const rows=await locale('market-solution.ts')
 for(const key of ['market.solution.manageLoaded','market.solution.catalogNewerVersion']){
  assert.ok(rows.includes('"'+key+'"')||rows.includes("'"+key+"'"),'缺少词条 '+key)
 }
 const loadApi=await source('industry-load-api.ts')
 assert.match(loadApi,/industry-loads\/unload/,'卸载走真实端点')
 assert.match(loadApi,/industry-loads\/upgrade/,'更新走真实端点')
})

test('员工退役/暂停入口来自真实 roles/lifecycle，且在员工详情可用',async()=>{
 const team=await source('TeamPage.tsx')
 assert.match(team,/role\.storage === 'persistent' && persistence && <RoleLifecycle/,'持久员工详情渲染真实生命周期组件')
 const lifecycle=await source('role-lifecycle-api.ts')
 assert.match(lifecycle,/roles\/lifecycle/,'生命周期调用真实端点')
 const component=await source('RoleLifecycle.tsx')
 assert.match(component,/roleLifecycle\.retire/,'提供退役入口')
 assert.match(component,/contrast|DangerConfirm/,'退役需要二次确认并列出影响')
})

test('技能硬卸载只经受校验的 SkillInstallApi 端点，并在详情危险区二次确认',async()=>{
 const files=(await readdir(clientDir,{withFileTypes:true})).filter(entry=>entry.isFile()&&/\.(ts|tsx)$/.test(entry.name)).map(entry=>entry.name)
 for(const file of files){
  if(file==='skill-install-api.ts')continue
  const content=await source(file)
  assert.doesNotMatch(content,/skill-installations\/uninstall/,'原始卸载端点只能出现在受校验的 API 模块：'+file)
 }
 const api=await source('skill-install-api.ts')
 assert.match(api,/skill-installations\/uninstall/,'技能硬卸载走后端真实端点')
 assert.match(api,/SkillUninstallInput/,'卸载请求必须有固定输入契约')
 assert.match(api,/'技能卸载回执格式不正确。'/,'卸载回执必须校验身份与格式')
 const installations=await source('RealSkillInstallations.tsx')
 assert.match(installations,/api\.uninstall\(/,'危险区通过 SkillInstallApi.uninstall 执行卸载')
 assert.match(installations,/market\.skill\.danger\.uninstall/,'提供卸载技能按钮词条')
 assert.match(installations,/record\.state==='installed'/,'只在已安装状态显示硬卸载')
 const pageRows=await locale('market-page.ts')
 assert.match(pageRows,/'market\.skill\.danger\.uninstall','卸载技能','卸載技能','Uninstall skill'/,'缺少技能卸载危险区词条（简繁英定稿）')
})
