import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {readFileSync} from 'node:fs'

function harness(){
 const source=readFileSync(new URL('../src/client/ProjectReferences.tsx',import.meta.url),'utf8')
 const states:any[]=[],effects:any[]=[];let cursor=0,pending:Array<()=>void>=[]
 const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),useState(initial:any){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],(value:any)=>states[i]=typeof value==='function'?value(states[i]):value]},useRef(initial:any){const i=cursor++;return states[i]??(states[i]={current:initial})},useEffect(fn:()=>any,deps:any[]){const i=cursor++;if(!effects[i]||deps.some((value,j)=>value!==effects[i].deps[j])){effects[i]?.cleanup?.();pending.push(()=>effects[i]={deps,cleanup:fn()})}}}
 const modules:Record<string,any>={react:React,'@teloa/contract':{projectLinkKinds:['task','resource']},'./i18n/provider.js':{useI18n:()=>({t:(key:string,params?:Record<string,unknown>)=>params?key+':'+JSON.stringify(params):key,locale:'en'})},'./i18n/errors.js':{localizeWorkError:()=> 'LOAD FAILED'},'./dialog-focus.js':{openDialog:()=>{}},'./project-presentation.js':{projectKindKeys:{task:'Task',resource:'Resource'},referenceScopeName:(ref:{scope:string},labels:Array<{scope:string;title:string}>,fallback:(scope:string)=>string)=>labels.find(label=>label.scope===ref.scope)?.title??fallback(ref.scope)},'./ProjectWorkspace.module.css':{default:{}},'lucide-react':{X:()=>{}}}
 const out:Record<string,any>={}
 new Function('require','exports','React',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText)((id:string)=>modules[id],out,React)
 const nodes=(node:any):any[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
 const render=(props:any)=>{cursor=0;const tree=out.ProjectReferences(props),jobs=pending;pending=[];jobs.forEach(fn=>fn());return tree}
 const settle=()=>new Promise(resolve=>setTimeout(resolve,220))
 return {render,nodes,settle}
}
const label=(scope:string,title:string)=>({scope,title,kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0})
const scopeLabels=[label('general','General'),label('SOC','Security Ops'),label('AppSec','AppSec')]
const task={kind:'task',id:'10000000-0000-4000-8000-000000000001',title:'SOC task',state:'ready',version:1,available:true,origin:'direct',attention:null}

test('业务下拉不含主业务；候选查询用所选业务调 candidates；选中 N 项按钮文案 count=N；提交的引用带 scope',async()=>{
 const {render,nodes,settle}=harness(),calls:Array<[string,string,string]>=[];let saved:unknown
 const props={project:{scope:'general',links:[],references:[]},api:{candidates:async(scope:string,kind:string,query:string)=>{calls.push([scope,kind,query]);return [task]}},scopeLabels,close(){},save:async(references:unknown)=>{saved=references}}
 render(props);await settle();let tree=render(props)
 const business=nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='project.reference.business')
 assert.deepEqual(nodes(business).filter(node=>node.type==='option').map(node=>node.props.value),['SOC','AppSec'])
 assert.deepEqual(calls[0],['SOC','task',''])
 business.props.onChange({target:{value:'AppSec'}});render(props);await settle();tree=render(props)
 assert.deepEqual(calls.at(-1),['AppSec','task',''])
 const checkbox=nodes(tree).find(node=>node.props.type==='checkbox');assert.ok(checkbox);checkbox.props.onChange({target:{checked:true}});tree=render(props)
 const submit=nodes(tree).find(node=>node.props.type==='submit')
 assert.equal(submit.props.disabled,false);assert.ok(submit.children.includes('project.reference.addSelected:{"count":1}'))
 await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}})
 assert.deepEqual(saved,[{kind:'task',id:task.id,scope:'AppSec'}])
})
test('读取失败时不显示旧候选且不能提交；已引用的条目不再列为候选',async()=>{
 const {render,nodes,settle}=harness();let saved:unknown
 const props={project:{scope:'general',links:[],references:[{kind:'task',id:task.id,scope:'SOC'}]},api:{candidates:async(_scope:string,kind:string)=>{if(kind==='resource')throw Error();return [task]}},scopeLabels,close(){},save:async(references:unknown)=>{saved=references}}
 render(props);await settle();let tree=render(props)
 assert.equal(nodes(tree).find(node=>node.props.type==='checkbox'),undefined,'已引用的 SOC 任务不再列出')
 nodes(tree).find(node=>node.type==='select'&&node.props['aria-label']==='project.relationType').props.onChange({target:{value:'resource'}})
 render(props);await settle();tree=render(props)
 assert.equal(nodes(tree).find(node=>node.props.type==='checkbox'),undefined)
 assert.equal(nodes(tree).find(node=>node.props.type==='submit').props.disabled,true)
 await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}})
 assert.equal(saved,undefined)
 assert.ok(nodes(tree).some(node=>node.props.role==='alert'))
})
