import test from 'node:test'
import assert from 'node:assert/strict'
import {mount,nodes} from './market-component-harness.ts'
import * as industryManifest from '../src/client/industry-manifest.ts'

for(const format of ['teloa.business-package/v2','teloa.business-package/v3'])test(format+' 公开引用导入在途阻止关闭、Esc 和返回文件选择，失败后可重试',async()=>{
 let finish!:(value:any)=>void,reject!:(error:Error)=>void,closed=0,saved=0
 const item={manifest:industryManifest.validateIndustryManifest({format,id:'public-consumer',title:'公共知识复用',version:'1.0.0',domain:'general',description:'复用固定知识',resources:[{id:'guide',kind:'knowledge',title:'研究方法',version:'1.0.0',required:true,source:{kind:'public',id:'research-guide',version:'1.0.0'}}],relations:[],entrypoints:[]})}
 const marker=()=>null
 const app=mount('MarketForms.tsx',{'./industry-manifest.ts':industryManifest,'./industry-directory.js':{readIndustryDirectory:async()=>item},'./industry-reference.js':{prepareIndustryReferenceCandidates:async()=>[]},'./IndustryReferences.js':{IndustryReferences:marker}})
 const props={mode:'upload',items:[],githubSourceApi:{pending(){},recoveryMessage(){}},contentApi:{hydrate:async(x:any)=>x,importIndustry:()=>new Promise((resolve,fail)=>{finish=resolve;reject=fail})},close(){closed++},save(){saved++},saveMany(){}}
 let tree=app.render('MarketImportForm',props)
 nodes(tree).find(node=>node.props['aria-label']==='market.forms.industry.template.directory')!.props.onChange({target:{files:[{name:'teloa.json',webkitRelativePath:'demo/teloa.json',size:1}]}})
 tree=app.render('MarketImportForm',props)
 nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 await new Promise(resolve=>setImmediate(resolve))
 tree=app.render('MarketImportForm',props)
 let pending=nodes(tree).find(node=>node.type===marker)!.props.save(item)
 tree=app.render('MarketImportForm',props)
 let prevented=false
 tree.props.onCancel({preventDefault(){prevented=true}})
 assert.equal(prevented,true);assert.equal(closed,0)
 assert.equal(nodes(tree).find(node=>node.props['aria-label']==='market.forms.close.market.import')!.props.disabled,true)
 assert.equal(nodes(tree).find(node=>node.type==='button'&&node.children.includes('market.forms.return.file.selection'))!.props.disabled,true)
 reject(Error('导入失败'));await assert.rejects(pending,/导入失败/)
 tree=app.render('MarketImportForm',props)
 assert.equal(nodes(tree).find(node=>node.props['aria-label']==='market.forms.close.market.import')!.props.disabled,false)
 pending=nodes(tree).find(node=>node.type===marker)!.props.save(item)
 finish(item);await pending
 assert.equal(saved,1)
})

test('自动化保存中阻止 Esc 与重复提交，保存失败后保留输入并恢复关闭',async()=>{
 let reject!:(reason:Error)=>void,calls=0,closed=0
 const saving=new Promise<void>((_,fail)=>{reject=fail})
 const app=mount('ContinuousPage.tsx',{
  './business-scope-context.js':{useBusinessScopes:()=>({general:'通用工作'})},
  './continuous-preview.js':{planNotificationPolicies:['attention']},
  './role-preview.js':{canReceiveTask:()=>true},
  './i18n/errors.js':{localizeWorkError:()=> '保存失败'},
 },['PlanForm'])
 const props={persistent:true,fallbackFocus(){},openMarket(){},draft:{fields:{title:'需要保留的计划',scope:'general',roleId:'r',goal:'核对资料',dataScope:'当前资料',delivery:'报告',notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'UTC'}}},roles:[{id:'r',storage:'persistent',name:'同事'}],patch(){},close(){closed++},save(){calls++;return saving},reload:undefined}
 let tree=app.render('PlanForm',props)
 const submit=()=>nodes(tree).find(node=>node.type==='form')!.props.onSubmit({preventDefault(){}})
 submit();tree=app.render('PlanForm',props);submit()
 let prevented=false
 tree.props.onCancel({preventDefault(){prevented=true}})
 assert.equal(prevented,true);assert.equal(closed,0)
 assert.equal(nodes(tree).find(node=>node.type==='button'&&node.props['aria-label']==='continuous.form.closeAria')!.props.disabled,true)
 await Promise.resolve();assert.equal(calls,1)
 reject(Error('暂时不可用'));await new Promise(resolve=>setImmediate(resolve))
 tree=app.render('PlanForm',props)
 assert.ok(nodes(tree).some(node=>node.props.role==='alert'))
 assert.ok(nodes(tree).some(node=>node.type==='input'&&node.props.value==='需要保留的计划'))
 tree.props.onCancel({preventDefault(){throw Error('失败后应允许退出')}})
 assert.equal(closed,1)
})
