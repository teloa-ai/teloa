import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
import * as industryManifest from '../src/client/industry-manifest.ts'

// N30：导入预览的身份只按真实清单里的员工资源数归类（0 → 模板、1 → AI 员工、多位 → AI 团队），不按名称或来源猜测。
const role=(id:string,title:string)=>({id,kind:'role',title,version:'1.0.0',required:true,source:{kind:'local',path:'roles/'+id+'.json'}})
const skill={id:'brief',kind:'skill',title:'简报',version:'1.0.0',required:true,source:{kind:'local',path:'skills/brief/SKILL.md'}}
const item=(resources:unknown[])=>({id:'draft',title:'调研模板',summary:'整理公开资料',version:'1.0.0',manifest:industryManifest.validateIndustryManifest({format:'teloa.business-package/v3',id:'draft',title:'调研模板',version:'1.0.0',domain:'general',description:'整理公开资料',resources,relations:[],entrypoints:[]}),recipeImport:{skills:[],routines:[],plugins:[],memory:{resourceIds:[]},sourceHash:'0'.repeat(64)}})
const render=(resources:unknown[])=>{
 const app=mount('MarketForms.tsx',{'./industry-manifest.ts':industryManifest},['RecipeImportPreview'])
 return nodes(app.exported.RecipeImportPreview({item:item(resources),candidates:[],catalog:null,selections:{},change(){},inspect(){},busy:false,catalogAvailable:false,openConnection:undefined}))
}

for(const [label,resources,expected,names] of [
 ['0 位员工',[skill],'template',[]],
 ['1 位员工',[role('analyst','研究员'),skill],'employee',['研究员']],
 ['多位员工',[role('analyst','研究员'),role('writer','写作者'),skill],'team',['研究员','写作者']],
] as const)test('导入预览身份：'+label,()=>{
 const tree=render([...resources]),identity=tree.find(node=>node.props['data-import-identity'])
 assert.equal(identity?.props['data-import-identity'],expected)
 const members=tree.filter(node=>node.props['data-import-member']).map(node=>node.props['data-import-member'])
 assert.deepEqual(members,expected==='team'?names:[],'团队逐位列出员工，单个员工与模板不重复列')
})
