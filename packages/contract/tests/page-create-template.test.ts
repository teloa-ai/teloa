import test from 'node:test'
import assert from 'node:assert/strict'
import {readPageCreateBody,pageCreateCanonicalBody,type PageCreateEntity} from '../src/page-create.ts'
import {readTemplateSharePackage,readTemplateShare} from '../src/template-share.mjs'

function template(){
 const id='00000000-0000-4000-8000-000000000001',version='1.0.0',title='写作员工',description='根据本人提供的资料写作。'
 const manifest={format:'teloa.business-package/v2',id,version,title,description,domain:'general',scope:'general',resources:[{id:'writer',kind:'role',title,version,required:true,source:{kind:'local',path:'roles/writer.json'}}],relations:[],entrypoints:[]}
 return {format:'teloa.template-share/v1',id,version,title,description,requirements:['提供本次资料。'],compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:['people']},files:[{path:'teloa.json',text:JSON.stringify(manifest)},{path:'roles/writer.json',text:JSON.stringify({format:'teloa.role/v1',kind:'employee',name:title,duty:description,dataScope:'本人明确提供的资料。',executionScope:'草拟内容，外发另行授权。'})}]}
}

test('自然语言直接生成可移植静态模板草案，不要求已有员工身份',()=>{
 const body={package:template()},result=readPageCreateBody('share' as PageCreateEntity,body)
 assert.deepEqual(result,{package:readTemplateSharePackage(body.package)})
 assert.equal(JSON.parse(pageCreateCanonicalBody(result)).package.title,'写作员工')
 assert.equal(Object.hasOwn(result as object,'roleId'),false)
})

test('模板草案复用分享判据，拒绝运行身份、未知字段和无效包',()=>{
 const body={package:template()},invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'
 assert.throws(()=>readPageCreateBody('share' as PageCreateEntity,{...body,roleId:'private'}),invalid)
 assert.throws(()=>readPageCreateBody('share' as PageCreateEntity,{package:{...body.package,ownerId:'source-owner'}}),invalid)
 assert.throws(()=>readPageCreateBody('share' as PageCreateEntity,{package:{...body.package,files:[]}}),invalid)
})

test('直接生成团队模板保留两位员工和明确协调关系，不要求先建业务',()=>{
 const base=template(),manifest=JSON.parse(base.files[0]!.text),version=base.version
 manifest.resources.push({id:'reviewer',kind:'role',title:'核对员工',version,required:true,source:{kind:'local',path:'roles/reviewer.json'}})
 base.files[0]!.text=JSON.stringify(manifest)
 base.files.push({path:'roles/reviewer.json',text:JSON.stringify({format:'teloa.role/v1',kind:'employee',name:'核对员工',duty:'核对事实与交付判据。',dataScope:'本人提供的资料。',executionScope:'只核对，不外发。'})})
 const pack={...base,format:'teloa.template-share/v2',subject:'team',license:'Apache-2.0',trust:{publisher:'模板作者'},provenance:{sources:[]},sourceFiles:[],team:{coordinatorResourceId:'writer'}}
 const result=readPageCreateBody('share',{package:pack}) as {package:ReturnType<typeof readTemplateShare>}
 assert.equal(result.package.format,'teloa.template-share/v2')
 assert.equal(JSON.parse(result.package.files.find(file=>file.path==='teloa.json')!.text).resources.length,2)
 assert.equal(JSON.parse(pageCreateCanonicalBody(result)).package.team.coordinatorResourceId,'writer')
 assert.equal(manifest.scope,'general')
})
