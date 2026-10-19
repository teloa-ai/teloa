/**
 * 分享包通过市场「导入模板」抽屉的导入路径测试。
 *
 * 覆盖：
 * 1. 粘贴 v2 分享包 JSON → 能识别并转换为行业包，不抛"未知字段"错误
 * 2. 上传 .json 文件为 v2 分享包 → 同上
 * 3. 目录/ZIP 扫描能识别 teloa.template-share/v2 格式的 JSON 文件
 * 4. 员工分享包（subject=employee）与团队分享包（subject=team）都能被识别
 * 5. 非 v2 分享包的 JSON 仍走旧流程（不影响已有行为）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {buildSharePlan,isSharePackageV2} from '../src/client/share-package-plan.ts'
import {shareIndustryItem} from '../src/client/template-share-accept.ts'
import {discoverIndustryTemplates,sharePackageItem,SharePackageImportError} from '../src/client/industry-directory.ts'
import {parseMarketManifest} from '../src/client/market-preview.ts'
import {isIndustryManifest} from '../src/client/industry-manifest.ts'

const skillText='---\nname: research-notes\ndescription: Keep notes\n---\n# Research notes\nCollect sources.'
const role=(id:string,name:string,skills:string[]=[])=>({
  id,name,kind:'employee' as const,duty:'Do research.',dataScope:'Provided documents.',executionScope:'Confirm before external writes.',skills,knowledge:[],scopes:['general']
})

// ---- 员工分享包 fixture ----
const employeePkg=buildSharePlan({
  publisher:'Max',license:'CC-BY-4.0',subject:'employee',
  roles:[role('r1','Research Assistant',['research-notes'])],
  skills:[{name:'research-notes',title:'Research Notes',resourceId:'research-notes',version:'1.2.0',text:skillText,license:'MIT',publisher:'Upstream'}]
})
// ---- 团队分享包 fixture ----
const teamPkg=buildSharePlan({
  publisher:'Max',license:'CC-BY-4.0',subject:'team',title:'Research team',
  roles:[role('r1','Lead',['research-notes']),role('r2','Writer')],
  coordinatorRoleId:'r1',
  skills:[{name:'research-notes',title:'Research Notes',resourceId:'research-notes',version:'1.0.0',text:skillText,license:'MIT'}]
})

// ── 1. isSharePackageV2 识别 ────────────────────────────────────────────────
test('isSharePackageV2 identifies employee and team share packages',()=>{
  assert.ok(isSharePackageV2(employeePkg),'employee pkg should be v2')
  assert.ok(isSharePackageV2(teamPkg),'team pkg should be v2')
  assert.ok(!isSharePackageV2({format:'teloa.business-package/v2',id:'x'}),'business package should not be v2 share')
  assert.ok(!isSharePackageV2(null),'null should not be v2 share')
})

// ── 2. shareIndustryItem 能把员工分享包转成行业包 ──────────────────────────
test('shareIndustryItem converts employee share package to industry MarketItem',async()=>{
  const skills=employeePkg.files.map(f=>f.path).filter(p=>p.endsWith('.json')&&!p.includes('teloa.json')).length
  const summary={scope:'general',skills:['research-notes']}
  const item=await shareIndustryItem(employeePkg,summary)
  assert.equal(item.kind,'bundle')
  assert.ok(item.packageContent,'should have packageContent')
  assert.ok(isIndustryManifest(item.manifest),'manifest should be industry manifest')
  const roles=item.manifest!.resources.filter((r:{kind:string})=>r.kind==='role')
  assert.equal(roles.length,1,'employee share should have 1 role')
  // 连接只声明，不自动授权
  assert.ok(item.license,'should preserve license')
  assert.equal(item.author,'Max','should preserve publisher as author')
})

// ── 3. shareIndustryItem 能把团队分享包转成行业包 ──────────────────────────
test('shareIndustryItem converts team share package to industry MarketItem',async()=>{
  const item=await shareIndustryItem(teamPkg,{scope:'general',skills:['research-notes']})
  assert.equal(item.kind,'bundle')
  assert.ok(isIndustryManifest(item.manifest),'should produce industry manifest')
  const roles=item.manifest!.resources.filter((r:{kind:string})=>r.kind==='role')
  assert.equal(roles.length,2,'team should have 2 roles')
})

// ── 4. parseMarketManifest 直接解析分享包 JSON 会抛错（证明修前红的场景）──
test('parseMarketManifest throws on share package JSON (pre-fix behavior proves the bug)',async()=>{
  const raw=JSON.stringify(employeePkg)
  // 分享包有 subject 字段，validateManifest 会抛 "清单含未知字段：subject"
  await assert.rejects(parseMarketManifest(raw),/未知字段|不支持此清单格式|subject/,'should reject share package JSON')
})

// ── 5. discoverIndustryTemplates 在目录中能识别分享包 JSON ─────────────────
test('discoverIndustryTemplates recognizes share package JSON in a directory',async()=>{
  const encoder=new TextEncoder()
  const pkgJson=JSON.stringify(employeePkg)
  const pkgBytes=encoder.encode(pkgJson)
  const inputs=[
    {path:'teloa-share.json',size:pkgBytes.length,read:async()=>pkgBytes},
    // 普通文件应被忽略
    {path:'readme.txt',size:5,read:async()=>new Uint8Array([1,2,3,4,5])},
  ]
  const results=await discoverIndustryTemplates(inputs,'test-dir')
  // 分享包 JSON 应该被识别（有 item 或有 error，不能是"没有发现"）
  const shareResult=results.find(r=>r.path==='teloa-share.json')
  assert.ok(shareResult,'share package file should be discovered')
  // 修前：item 是 undefined（识别失败），修后：item 应有值
  assert.ok(shareResult.item,'share package should be recognized as importable item')
  assert.ok(!shareResult.error,shareResult.error??'')
})

// ── 6. 只有 teloa.template-share/v2 的 JSON 被特殊处理，其他格式不受影响 ──
test('discoverIndustryTemplates does not change behavior for non-share JSON files',async()=>{
  const encoder=new TextEncoder()
  // 有效的行业包 JSON
  const manifest={format:'teloa.business-package/v2',id:'test-bundle',version:'1.0.0',title:'Test Bundle',description:'Test',domain:'general',scope:'general',resources:[{id:'r1',kind:'role',title:'Agent',version:'1.0.0',required:true,source:{kind:'local',path:'agent.json'}}],relations:[],entrypoints:[]}
  const agentDef={format:'teloa.role/v1',kind:'employee',name:'Agent',duty:'Do work.',dataScope:'Provided docs.',executionScope:'Confirm before writes.'}
  const manifestBytes=encoder.encode(JSON.stringify(manifest))
  const agentBytes=encoder.encode(JSON.stringify(agentDef))
  const inputs=[
    {path:'teloa.json',size:manifestBytes.length,read:async()=>manifestBytes},
    {path:'agent.json',size:agentBytes.length,read:async()=>agentBytes},
  ]
  const results=await discoverIndustryTemplates(inputs,'industry-dir')
  const result=results.find(r=>r.path==='teloa.json')
  assert.ok(result,'industry manifest should be discovered')
  assert.ok(result.item,'industry manifest should produce an item')
  assert.ok(!result.error,result.error??'')
})

// ── 7. 粘贴/上传共用的 sharePackageItem：分享包得到带真实内容哈希的行业包，目录发现与之一致 ──
test('sharePackageItem converts pasted share packages with the same content hash as directory discovery',async()=>{
  const pasted=await sharePackageItem(JSON.parse(JSON.stringify(employeePkg)))
  assert.ok(pasted?.packageContent,'share package should become an importable industry item')
  assert.ok(pasted.packageContent.files.every(file=>/^[0-9a-f]{64}$/.test(file.hash)),'every file keeps a real content hash')
  assert.equal(pasted.trust?.signature.status,'unverified')
  const bytes=new TextEncoder().encode(JSON.stringify(employeePkg))
  const [found]=await discoverIndustryTemplates([{path:'employee.teloa-share.json',size:bytes.length,read:async()=>bytes}],'dir')
  assert.equal(found?.item?.packageContent?.hash,pasted.packageContent.hash)
  assert.equal(await sharePackageItem({format:'teloa.business-package/v2'}),undefined)
  assert.equal(await sharePackageItem(undefined),undefined)
})

// ── 8. 分享包校验失败给出可理解原因，不显示契约英文原文 ──
test('sharePackageItem reports readable issues for invalid share packages',async()=>{
  const secret=structuredClone(employeePkg) as {files:{path:string;text:string}[]}
  const skill=secret.files.find(file=>file.path.endsWith('.md'))!
  skill.text+='\napi_key: '+'A'.repeat(24)
  await assert.rejects(sharePackageItem(secret),(error:unknown)=>error instanceof SharePackageImportError&&error.issue==='credential'&&/密钥/.test(error.message))
  await assert.rejects(sharePackageItem({...structuredClone(employeePkg),subject:'robot'}),(error:unknown)=>error instanceof SharePackageImportError&&error.issue==='invalid'&&!/Template/.test(error.message))
})
