import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
test('关联类型切换读取失败时不显示旧候选且不能提交',async()=>{
const source=readFileSync(new URL('../src/client/ProjectRelations.tsx',import.meta.url),'utf8')
const states:any[]=[],effects:any[]=[];let cursor=0,pending:Array<()=>void>=[]
const React={createElement:(type:any,props:any,...children:any[])=>({type,props:props??{},children:children.flat(Infinity)}),useState(initial:any){const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],(value:any)=>states[i]=typeof value==='function'?value(states[i]):value]},useRef(initial:any){const i=cursor++;return states[i]??(states[i]={current:initial})},useEffect(fn:()=>any,deps:any[]){const i=cursor++;if(!effects[i]||deps.some((value,j)=>value!==effects[i].deps[j])){effects[i]?.cleanup?.();pending.push(()=>effects[i]={deps,cleanup:fn()})}}}
const modules:Record<string,any>={react:React,'@teloa/contract':{projectLinkKinds:['task','resource']},'./i18n/provider.js':{useI18n:()=>({t:(key:string)=>key,locale:'en'})},'./i18n/errors.js':{localizeWorkError:()=> 'LOAD FAILED'},'./dialog-focus.js':{openDialog:()=>{}},'./project-presentation.js':{projectKindKeys:{task:'Task',resource:'Resource'}},'./ProjectWorkspace.module.css':{default:{}},'lucide-react':{X:()=>{}}}
const out:Record<string,any>={}
new Function('require','exports','React',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText)((id:string)=>modules[id],out,React)
const task={kind:'task',id:'10000000-0000-4000-8000-000000000001',title:'Previous task'};let saved:unknown
const props={project:{scope:'general',links:[]},api:{candidates:async(_scope:string,kind:string)=>{if(kind==='resource')throw Error();return [task]}},close(){},save:async (links:unknown)=>{saved=links}}
const nodes=(node:any):any[]=>node&&typeof node==='object'&&'props'in node?[node,...node.children.flatMap(nodes)]:[]
function render(){cursor=0;const tree=out.ProjectRelations(props),jobs=pending;pending=[];jobs.forEach(fn=>fn());return tree}
render();await new Promise(resolve=>setTimeout(resolve,220));let tree=render()
nodes(tree).find(node=>node.type==='select').props.onChange({target:{value:'resource'}})
render();await new Promise(resolve=>setTimeout(resolve,220));tree=render()
const checkbox=nodes(tree).find(node=>node.props.type==='checkbox')
assert.equal(nodes(tree).find(node=>node.type==='select').props.value,'resource')
assert.equal(checkbox,undefined)
const submit=nodes(tree).find(node=>node.props.type==='submit');assert.equal(submit.props.disabled,true)
await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}})
assert.equal(saved,undefined)
assert.equal(nodes(tree).some(node=>node.children.includes('project.noCandidates')),false)
})
