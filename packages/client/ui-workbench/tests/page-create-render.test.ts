import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import * as React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import type {PageCreateDraft,PageCreateDraftDirectory,PageCreateDraftPreview} from '@teloa/contract'
import type {CreateEntryProps} from '../src/client/CreateEntry.js'
import * as presentation from '../src/client/page-create-presentation.ts'
import {PAGE_CREATE_MESSAGE_ROWS} from '../src/client/i18n/locales/page-create.ts'

const dictionary=new Map<string,string>(PAGE_CREATE_MESSAGE_ROWS.map(row=>[row[0],row[1]]))
const t=(key:string,params?:Record<string,string|number>)=>{
 const value=dictionary.get(key)??key
 return value.replace(/\{(\w+)\}/g,(_,name:string)=>String(params?.[name]??''))
}
const stamp='2026-09-17T01:00:00.000Z'
const draft=(patch:Partial<PageCreateDraft>={}):PageCreateDraft=>({id:'draft-1',ownerId:'owner',requestId:'request-1',entity:'role',body:'{}',bodyHash:'a'.repeat(64),title:'核对账单',status:'draft',createdAt:stamp,updatedAt:stamp,...patch})
const directory=(drafts=[draft()]):PageCreateDraftDirectory=>({schema:'teloa.page-create-drafts/v1',entity:'role',readAt:stamp,drafts})
const preview=(value=draft()):PageCreateDraftPreview=>({schema:'teloa.page-create-draft-preview/v1',draft:value,fields:[{path:'name',value:value.title}],fieldsTruncated:false,consequences:[{kind:'credential',id:'账单来源',required:true}],next:{endpoint:'roles/create',consentKeys:['create.consequence.credential']},computedAt:stamp})
function deferred<T>(){
 let resolve!:(value:T)=>void, reject!:(reason:unknown)=>void
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
 return {promise,resolve,reject}
}

type Element=React.ReactElement<Record<string,any>>
const elements=(node:React.ReactNode):Element[]=>{
 if(Array.isArray(node))return node.flatMap(elements)
 if(!React.isValidElement<Record<string,any>>(node))return []
 return [node,...elements(node.props.children)]
}
const content=(node:React.ReactNode):string=>{
 if(Array.isArray(node))return node.map(content).join('')
 if(React.isValidElement<Record<string,any>>(node))return content(node.props.children)
 return typeof node==='string'||typeof node==='number'?String(node):''
}

/** 执行真实组件函数与 React 文本渲染；仅替换钩子调度，真实运行 effect 清理、延迟回包及按钮回调。 */
function mount(input:Partial<CreateEntryProps>={}){
 let props:CreateEntryProps={entity:'role',api:{directory:async()=>directory(),preview:async()=>preview(),settle:async()=>directory([])},prepare:()=>{},onConfirm:()=> 'test-created',...input}
 let slots:unknown[]=[],cursor=0,dirty=true,key:React.Key|null=null,tree:React.ReactNode
 type Effect={deps:readonly unknown[];cleanup?:(()=>void)|undefined}
 let effects=new Map<number,Effect>(),pending:Array<()=>void>=[]
 const hooks={...React,
  useState:(initial:unknown)=>{const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?(initial as ()=>unknown)():initial;return [slots[index],(next:unknown)=>{const value=typeof next==='function'?(next as (before:unknown)=>unknown)(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true}}]},
  useRef:(initial:unknown)=>{const index=cursor++;return slots[index]??(slots[index]={current:initial})},
  useEffect:(run:()=>void|(()=>void),deps:readonly unknown[])=>{
   const index=cursor++,previous=effects.get(index)
   if(previous&&deps.every((value,index)=>Object.is(value,previous.deps[index])))return
   pending.push(()=>{previous?.cleanup?.();effects.set(index,{deps,cleanup:run()??undefined})})
  },
 }
 const code=ts.transpileModule(readFileSync(new URL('../src/client/CreateEntry.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText
 const exported:Record<string,any>={}
 const require=(id:string)=>{
  if(id==='react')return hooks
  if(id.endsWith('provider.js'))return {useI18n:()=>({t})}
  if(id.endsWith('page-create-presentation.js'))return presentation
  if(id.endsWith('use-dismissible.js'))return {useDismissible:()=>{}}
  if(id.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})}
  throw Error('未声明的组件依赖：'+id)
 }
 new Function('require','exports','React',code)(require,exported,hooks)
 const render=()=>{
  const root=exported.CreateEntry(props) as Element
  if(root.key!==key){for(const effect of effects.values())effect.cleanup?.();effects=new Map();slots=[];key=root.key}
  let guard=0
  do{
   assert.ok(guard++<20,'组件不应无限重渲染')
   dirty=false;cursor=0;pending=[]
   tree=(root.type as (props:CreateEntryProps)=>React.ReactNode)(root.props as CreateEntryProps)
   for(const run of pending)run()
  }while(dirty)
  return tree
 }
 const flush=async()=>{for(let round=0;round<8;round++){await Promise.resolve();render()}return tree}
 const button=(label:string)=>{const matches=elements(render()).filter(node=>node.type==='button'&&content(node)===label);assert.equal(matches.length,1,'按钮身份必须唯一：'+label);return matches[0]!}
 const open=(id='draft-1',value=true)=>{
  const entry=elements(render()).find(node=>node.type==='li'&&node.key===id)
  assert.ok(entry,'必须命中指定草案行：'+id)
  const details=elements(entry).find(node=>node.type==='details')!
  details.props.onToggle({currentTarget:{open:value}})
  render()
 }
 render()
 return {render,flush,button,open,html:()=>renderToStaticMarkup(render()),setProps:(patch:Partial<CreateEntryProps>)=>{props={...props,...patch};render()}}
}

test('预览完成之前没有确认，读到之后显示三块文本与人话步骤',async()=>{
 const pending=deferred<PageCreateDraftPreview>()
 const app=mount({api:{directory:async()=>directory(),preview:()=>pending.promise,settle:async()=>directory([])}})
 await app.flush();app.open()
 assert.ok(!elements(app.render()).some(node=>node.type==='button'&&content(node)==='确认'))
 pending.resolve(preview());await app.flush()
 assert.equal(app.button('确认').props.disabled,false)
 for(const text of ['要建什么','会带来什么','下一步',"员工入职表单",'还需要你另外输入密钥'])assert.ok(app.html().includes(text))
 assert.ok(!app.html().includes('roles/create'))
})

test('同步确认抛错也退出忙态；必须重新读取预览后才能再确认',async()=>{
 let reads=0,calls=0
 const app=mount({onConfirm:()=>{calls++;throw Object.assign(Error('内部正文不得展示'),{code:'teloa/version-conflict'})},api:{directory:async()=>directory(),preview:async()=>{reads++;return preview()},settle:async()=>directory([])}})
 await app.flush();app.open();await app.flush()
 await app.button('确认').props.onClick();await app.flush()
 assert.equal(calls,1)
 assert.ok(app.html().includes(dictionary.get('create.conflict')!))
 assert.ok(!app.html().includes('内部正文不得展示'))
 assert.ok(!elements(app.render()).some(node=>node.type==='button'&&content(node)==='确认'))
 const alert=elements(app.render()).find(node=>node.props.role==='alert')!
 elements(alert).find(node=>node.type==='button')!.props.onClick()
 await app.flush()
 assert.equal(reads,2)
 assert.equal(app.button('确认').props.disabled,false)
})

test('调用方打开既有表单后由用户取消，不把取消误报为草案读取或保存失败',async()=>{
 const app=mount({onConfirm:()=>Promise.reject({code:'teloa/cancelled'})})
 await app.flush();app.open();await app.flush()
 await app.button('确认').props.onClick();await app.flush()
 assert.ok(!app.html().includes(dictionary.get('create.readFailed')!))
 assert.equal(app.button('确认').props.disabled,false)
})

test('同一事件循环重复确认只调用一次；既有写路径成功后才按真实落地记录落定草案',async()=>{
 let calls=0,settles=0,after:string|undefined
 const pending=deferred<string>();let settled:unknown
 const app=mount({onConfirm:()=>{calls++;return pending.promise},afterConfirm:value=>{after=value},api:{directory:async()=>directory(),preview:async()=>preview(),settle:async payload=>{settles++;settled=payload;return directory([])}}})
 await app.flush();app.open();await app.flush()
 const click=app.button('确认').props.onClick
 const first=click();await click()
 assert.equal(calls,1)
 assert.equal(app.button('正在确认…').props.disabled,true)
 pending.resolve('role-created-1');await first;await app.flush()
 assert.equal(settles,1)
 assert.equal(after,'role-created-1')
 assert.deepEqual({...settled as Record<string,unknown>,requestId:'request'},{requestId:'request',draftId:'draft-1',expectedBodyHash:'a'.repeat(64),outcome:'applied',appliedRef:'role-created-1'})
})

test('带独立同意流程的既有写路径完成后，才允许自定义确认区落定草案',async()=>{
 let settled:unknown,after:string|undefined
 const app=mount({entity:'extension',onConfirm:()=>{throw Error('插件流程不应走通用确认')},afterConfirm:value=>{after=value},renderConfirmation:({apply})=>React.createElement('button',{type:'button',onClick:()=>void apply('plugin-installation-1')},'完成插件安装'),api:{directory:async()=>({...directory(),entity:'extension'}),preview:async()=>preview(draft({entity:'extension'})),settle:async payload=>{settled=payload;return directory([])}}})
 await app.flush();app.open();await app.flush()
 await app.button('完成插件安装').props.onClick();await app.flush()
 assert.deepEqual({...settled as Record<string,unknown>,requestId:'request'},{requestId:'request',draftId:'draft-1',expectedBodyHash:'a'.repeat(64),outcome:'applied',appliedRef:'plugin-installation-1'})
 assert.equal(after,'plugin-installation-1')
})

test('丢弃逐字提交当前预览摘要，失败保留草案且不误报落地成功',async()=>{
 let sent:unknown
 const app=mount({api:{directory:async()=>directory(),preview:async()=>preview(draft({bodyHash:'b'.repeat(64)})),settle:async payload=>{sent=payload;throw Error('断线')}}})
 await app.flush();app.open();await app.flush()
 await app.button('丢弃').props.onClick();await app.flush()
 assert.deepEqual({...sent as Record<string,unknown>,requestId:'request'}, {requestId:'request',draftId:'draft-1',expectedBodyHash:'b'.repeat(64),outcome:'discarded'})
 assert.ok(app.html().includes('核对账单'))
 assert.ok(app.html().includes(dictionary.get('create.readFailed')!))
})

test('展开另一行后，旧 details 的迟到关闭事件不能收掉新行；旧预览也不能出现在新行',async()=>{
 const second=deferred<PageCreateDraftPreview>()
 const app=mount({api:{directory:async()=>directory([draft(),draft({id:'draft-2',title:'第二条'})]),preview:async({draftId})=>draftId==='draft-1'?preview():second.promise,settle:async()=>directory([])}})
 await app.flush();app.open();await app.flush()
 app.open('draft-2');app.open('draft-1',false)
 const opened=elements(app.render()).filter(node=>node.type==='details'&&node.props.open)
 assert.equal(opened.length,1)
 assert.ok(content(opened[0]).includes('第二条'))
 assert.ok(!elements(opened[0]).some(node=>node.type==='button'&&content(node)==='确认'))
 second.resolve(preview(draft({id:'draft-2',title:'第二条'})));await app.flush()
 assert.equal(app.button('确认').props.disabled,false)
})

test('换范围时撤销旧请求与预览，迟到回包不能恢复旧草案',async()=>{
 const pending=deferred<PageCreateDraftDirectory>(),signals:AbortSignal[]=[]
 const app=mount({scope:'SOC',api:{directory:async(_input,signal)=>{signals.push(signal!);return pending.promise},preview:async()=>preview(),settle:async()=>directory([])}})
 app.setProps({scope:'AppSec'})
 assert.equal(signals[0]!.aborted,true)
 assert.equal(signals[1]!.aborted,false)
 app.setProps({api:{directory:async()=>({...directory([]),scope:'AppSec'}),preview:async()=>preview(),settle:async()=>directory([])}})
 pending.resolve(directory());await app.flush()
 assert.ok(!app.html().includes('核对账单'))
})

test('目录读取失败呈现错误和重试，重新读取可以发现新生成的草案',async()=>{
 let reads=0
 const app=mount({api:{directory:async()=>{if(++reads===1)throw Error('坏回包');return directory()},preview:async()=>preview(),settle:async()=>directory([])}})
 await app.flush()
 assert.ok(app.html().includes(dictionary.get('create.readFailed')!))
 const alert=elements(app.render()).find(node=>node.props.role==='alert')!
 elements(alert).find(node=>node.type==='button')!.props.onClick();await app.flush()
 assert.ok(app.html().includes('核对账单'))
})

test('草案标题与三块字段中的 HTML 作为文字转义，不产生元素',async()=>{
 const injected='<img src=x onerror=alert(1)>'
 const data=draft({title:injected})
 const app=mount({api:{directory:async()=>directory([data]),preview:async()=>preview(data),settle:async()=>directory([])}})
 await app.flush();app.open();await app.flush()
 assert.match(app.html(),/&lt;img src=x onerror=alert\(1\)&gt;/)
 assert.doesNotMatch(app.html(),/<img\b/)
})

test('一句话只进入准备回调，输入不为空才可交给会话，并给出真实的发送和刷新指引',async()=>{
 let prepared:unknown
 const app=mount({prepare:prompt=>{prepared=prompt}})
 await app.flush();app.button('用一句话描述').props.onClick()
 assert.equal(app.button("交给会话里的员工").props.disabled,true)
 const textarea=elements(app.render()).find(node=>node.type==='textarea')!
 textarea.props.onChange({target:{value:'帮我核对账单'}})
 const form=elements(app.render()).find(node=>node.type==='form')!
 form.props.onSubmit({preventDefault:()=>{}})
 await app.flush()
 const lines=[
  dictionary.get('create.sentence.prompt.entity')!.replace('{entity}',dictionary.get('create.entity.role')!),
  dictionary.get('create.sentence.prompt.noScope')!,
  dictionary.get('create.sentence.prompt')!,
 ]
 assert.deepEqual(prepared,{sourceId:'role:',title:'新建',text:lines.join('\n')+'\n帮我核对账单'})
 assert.ok(app.html().includes('请在会话中发送'))
})

test('预览返回同 id 的另一业务范围时显示错误，不让用户确认错范围草案',async()=>{
 const app=mount({api:{directory:async()=>directory(),preview:async()=>preview(draft({scope:'AppSec'})),settle:async()=>directory([])}})
 await app.flush();app.open();await app.flush()
 assert.ok(app.html().includes(dictionary.get('create.readFailed')!))
 assert.ok(!elements(app.render()).some(node=>node.type==='button'&&content(node)==='确认'))
})
