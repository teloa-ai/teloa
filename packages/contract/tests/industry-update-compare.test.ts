import test from 'node:test'
import assert from 'node:assert/strict'
import {compareIndustryUpdateCore,industryUpdateChoiceProblem,industryUpdateResourceOptions,readIndustryUpdateChoices,type IndustryUpdateSide} from '../src/index.ts'

const role={id:'role',kind:'role',title:'研究岗',version:'1.0.0',required:true,source:{kind:'local' as const,path:'role.json'}}
const guide={id:'guide',kind:'knowledge',title:'手册',version:'1.0.0',required:true,source:{kind:'local' as const,path:'guide.md'}}
const side=(options:{body?:string;removeRole?:boolean;resources?:IndustryUpdateSide['manifest']['resources'];relations?:IndustryUpdateSide['manifest']['relations'];entrypoints?:string[];title?:string;description?:string}={}):IndustryUpdateSide=>({
 manifest:{
  title:options.title??'同名模板',description:options.description??'研究资料',
  resources:options.resources??(options.removeRole?[guide]:[role,guide]),
  relations:options.relations??(options.removeRole?[]:[{kind:'role-knowledge',from:'role',to:'guide'}]),
  entrypoints:options.entrypoints??[],
 },
 manifestPath:'teloa.json',
 files:[{path:'teloa.json',hash:'a'.repeat(64)},{path:'role.json',hash:'b'.repeat(64)},{path:'guide.md',hash:options.body==='新'?'d'.repeat(64):'c'.repeat(64)}],
})

test('同版本正文变化按实际文件摘要识别，定义未动的资源保持未变化',()=>{
 const diff=compareIndustryUpdateCore(side(),side({body:'新'}))
 assert.equal(diff.resources.find(row=>row.id==='guide')?.change,'changed')
 assert.deepEqual(diff.resources.find(row=>row.id==='guide')?.reasons,['内容'])
 assert.equal(diff.resources.find(row=>row.id==='role')?.change,'unchanged')
 assert.equal(diff.positioningChanged,false)
 assert.equal(diff.relationsChanged,false)
})

test('移除资源与行业说明变化分别落到 removed 与定位差异，不牵连其余资源',()=>{
 const diff=compareIndustryUpdateCore(side(),side({removeRole:true,description:'新的行业定位'}))
 assert.equal(diff.resources.find(row=>row.id==='role')?.change,'removed')
 assert.equal(diff.resources.find(row=>row.id==='guide')?.change,'unchanged')
 assert.equal(diff.relationsChanged,true)
 assert.equal(diff.positioningChanged,true)
})

test('关联与入口差异逐条列出，同一标识换类型单独列为不可就地升级',()=>{
 const candidate=side({resources:[role,{...guide,kind:'skill'}],relations:[{kind:'role-skill',from:'role',to:'guide'}],entrypoints:['guide']})
 const diff=compareIndustryUpdateCore(side(),candidate)
 assert.deepEqual(diff.relationChanges,[{change:'removed',kind:'role-knowledge',from:'role',to:'guide'},{change:'added',kind:'role-skill',from:'role',to:'guide'}])
 assert.deepEqual(diff.entrypointChanges,[{change:'added',id:'guide'}])
 assert.deepEqual(diff.kindChanges,[{id:'guide',title:'手册',before:'knowledge',after:'skill'}])
 assert.equal(diff.entrypointsChanged,true)
})

test('公共引用按解析结果比较，未解析的引用两侧都不可比因而计为内容变化',()=>{
 const reference={id:'brief',kind:'skill',title:'简报',version:'1.0.0',required:false,source:{kind:'public' as const,id:'brief',version:'1.0.0'}}
 const base={...side(),manifest:{...side().manifest,resources:[reference]}}
 const resolved=(hash:string)=>({...base,resolved:[{resourceId:'brief',sourceItemId:'market-brief',sourceResourceId:'brief',sourceHash:hash}]})
 assert.equal(compareIndustryUpdateCore(resolved('e'.repeat(64)),resolved('e'.repeat(64))).resources[0]?.change,'unchanged')
 assert.deepEqual(compareIndustryUpdateCore(resolved('e'.repeat(64)),resolved('f'.repeat(64))).resources[0]?.reasons,['内容'])
 assert.deepEqual(compareIndustryUpdateCore(base,resolved('e'.repeat(64))).resources[0]?.reasons,['内容'])
})

test('处理方式按变化类型固定，选择必须逐项覆盖变化资源且不覆盖未变化资源',()=>{
 assert.deepEqual(industryUpdateResourceOptions('added','knowledge'),['candidate','skip'])
 assert.deepEqual(industryUpdateResourceOptions('changed','knowledge'),['keep','candidate','skip'])
 // 只有 kit 管理状态的四类资源有"解除"这个终态；其余资源的本地对象在模板移除后一律保留，只能搁置。
 for(const kind of ['data-source','execution-tool','mcp','plugin'])assert.deepEqual(industryUpdateResourceOptions('removed',kind),['detach','skip'],kind)
 for(const kind of ['knowledge','role','skill','plan','task','work-template'])assert.deepEqual(industryUpdateResourceOptions('removed',kind),['skip'],kind)
 const diff=compareIndustryUpdateCore(side(),side({body:'新'}))
 const base={resources:{},roles:{},relations:'keep',entrypoints:'keep',positioning:'keep'} as const
 assert.match(industryUpdateChoiceProblem(diff,base)!,/请选择处理方式/)
 assert.match(industryUpdateChoiceProblem(diff,{...base,resources:{guide:'detach'}})!,/处理方式与资源变化不符/)
 assert.match(industryUpdateChoiceProblem(diff,{...base,resources:{guide:'keep',role:'keep'}})!,/重新比较/)
 assert.equal(industryUpdateChoiceProblem(diff,{...base,resources:{guide:'candidate'}}),undefined)
})

test('升级选择只接受既定键形与取值，未知字段与越界键一律拒绝',()=>{
 const owner='3f2504e0-4f89-41d3-9a0c-0305e82c3301'
 const value={resources:{guide:'candidate'},roles:{[owner]:'use-template'},relations:'keep',entrypoints:'candidate',positioning:'keep'}
 assert.deepEqual(readIndustryUpdateChoices(value),value)
 assert.notEqual(readIndustryUpdateChoices(value).resources,value.resources)
 assert.throws(()=>readIndustryUpdateChoices({...value,extra:1}),/格式不正确/)
 assert.throws(()=>readIndustryUpdateChoices({...value,resources:{'bad id':'candidate'}}),/资源处理方式/)
 assert.throws(()=>readIndustryUpdateChoices({...value,resources:{guide:'use-template'}}),/资源处理方式/)
 assert.throws(()=>readIndustryUpdateChoices({...value,roles:{guide:'keep-local'}}),/员工处理方式/)
 assert.throws(()=>readIndustryUpdateChoices({...value,relations:'detach'}),/保留或采用候选/)
 assert.throws(()=>readIndustryUpdateChoices([]),/格式不正确/)
})


test('模型版本或必需性变化必须明确采用，不能以沿用旧实例掩盖候选模型声明',()=>{
 const dependency={catalogId:'teloa.model.sensevoice',version:'1.0.0',usage:'speech-to-text' as const,required:true}
 const work={...guide,kind:'work-template',modelDependencies:[dependency]}
 for(const next of [{...dependency,version:'2.0.0'},{...dependency,required:false}]){
  const diff=compareIndustryUpdateCore(side({resources:[work]}),side({resources:[{...work,modelDependencies:[next]}]}))
  const row=diff.resources[0]!
  assert.ok(row.reasons.includes('模型依赖'))
  assert.deepEqual(industryUpdateResourceOptions(row.change,row.kind,row.reasons),['candidate'])
  const base={roles:{},relations:'keep',entrypoints:'keep',positioning:'keep'} as const
  assert.match(industryUpdateChoiceProblem(diff,{...base,resources:{guide:'keep'}})!,/模型依赖/)
  assert.equal(industryUpdateChoiceProblem(diff,{...base,resources:{guide:'candidate'}}),undefined)
 }
})
