import './fixtures/brand-asset-hooks.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import {readAtomicSkill} from '../src/client/atomic-skill.ts'
import {createMarketContentApi} from '../src/client/market-content-api.ts'
import {canonicalMarketItemId,findMarketItem,fixedMarketItemId,matchingMarketItems,mergeMarketItems,sameMarketItem} from '../src/client/market-item-identity.ts'
import {saveMarketIntent} from '../src/client/market-preview.ts'
import {mount,nodes,marketProps} from './market-component-harness.ts'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
import {marketItemId} from '../src/client/market-item-identity.ts'

const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222',createdAt='2026-10-01T00:00:00.000Z'
async function fixture(){
 const bytes=new TextEncoder().encode('---\nname: notes\ndescription: Supplied notes only\n---\nUse supplied notes only.'),skill=await readAtomicSkill([{path:'notes/SKILL.md',size:bytes.length,read:async()=>bytes}],{id:'notes',title:'Notes',version:'1.0.0',categories:[]})
 const content=(id:string)=>({id,ownerId:'owner',kind:'atomic-skill',logicalId:skill.id,version:skill.version,hash:skill.hash,baseHash:skill.hash,manifestPath:skill.entryPath,metadata:{id:skill.id,title:skill.title,version:skill.version,categories:[]},files:skill.files.map(row=>({path:row.path,hash:row.hash,base64:btoa(String.fromCharCode(...row.bytes))})),provides:[{resourceId:skill.id,kind:'skill',version:skill.version,path:skill.entryPath}],references:[],createdAt})
 const records=[content(first),content(second)],api=createMarketContentApi(async(name,payload)=>{
  if(name==='market-content/list')return {items:records.map(({files:_,...row})=>row),nextCursor:null}
  assert.equal(name,'market-content/get');return records.find(row=>row.id===(payload as {contentId:string}).contentId)
 })
 return {skill,api,summary:await api.list()}
}

test('两份同字节固定内容保持独立页面身份，目录与原文读取一致且旧hash不进入来源合同的UI身份',async()=>{
 const {api,summary,skill}=await fixture();assert.deepEqual(summary.map(row=>row.id),[fixedMarketItemId(first),fixedMarketItemId(second)])
 const full=await Promise.all(summary.map(row=>api.hydrate(row)));assert.deepEqual(full.map(row=>row.id),summary.map(row=>row.id))
 assert.ok(full.every(row=>row.atomicSkill?.text===skill.text));assert.ok(full.every(row=>canonicalMarketItemId(row)==='atomic-'+skill.hash))
 assert.equal(findMarketItem(full,fixedMarketItemId(first))?.contentStorage?.contentId,first)
 assert.equal(findMarketItem(full,fixedMarketItemId(second))?.contentStorage?.contentId,second)
 assert.equal(findMarketItem(full,'stored-33333333-3333-4333-8333-333333333333'),undefined)
 await assert.rejects(()=>api.hydrate({...summary[0]!,id:fixedMarketItemId(second)}),/目录摘要不一致/)
 // 旧目录快照可原样读回，不要求修改旧导航或公共sourceItemId。
 assert.equal((await api.hydrate({...summary[0]!,id:'atomic-'+skill.hash})).id,fixedMarketItemId(first))
})

test('合并同固定内容只保一条且不降级已读取正文，不同content或无content不同id不互相覆盖',async()=>{
 const {api,summary}=await fixture(),full=await api.hydrate(summary[0]!),before=structuredClone(summary)
 const merged=mergeMarketItems([full],summary);assert.equal(merged.length,2);assert.equal(merged[0],full);assert.ok(merged[0]!.atomicSkill)
 assert.equal(mergeMarketItems(summary,[full])[0],full);assert.deepEqual(summary,before)
 const unstored=summary.map(({contentStorage:_stored,...row},index)=>({...row,id:'draft-'+index}))
 assert.equal(mergeMarketItems([],unstored).length,2);assert.equal(sameMarketItem(unstored[0]!,unstored[1]!),false)
 assert.equal(sameMarketItem(unstored[0]!,summary[0]!),false)
})

test('同一固定内容的类型、版本、整包摘要或声明冲突会拒绝且不改原目录',async()=>{
 const {summary,api}=await fixture(),original=structuredClone(summary),full=await api.hydrate(summary[0]!)
 const trust={publisher:'Supplied publisher',repository:null,license:{status:'declared' as const,value:'MIT'},signature:{status:'unverified' as const,signer:null},compatibility:{teloa:'*',dsh:'*'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review' as const,summary:'Supplied declaration'}}
 for(const changed of [{...summary[0]!,kind:'bundle' as const},{...summary[0]!,version:'2.0.0'},{...summary[0]!,hash:'f'.repeat(64)}])assert.throws(()=>mergeMarketItems(summary,[changed]),/固定内容.*不一致/)
 assert.throws(()=>mergeMarketItems([{...full,trust}],[{...summary[0]!,trust:{...trust,publisher:'Another publisher'}}]),/固定内容.*不一致/)
 const reordered={review:trust.review,permissions:[],externalCapabilities:[],plugins:[],compatibility:trust.compatibility,signature:trust.signature,license:trust.license,repository:null,publisher:trust.publisher}
 assert.equal(mergeMarketItems([{...full,trust}],[{...summary[0]!,trust:reordered}]).length,1)
 assert.deepEqual(summary,original)
})

test('目录合并失败由原页面错误入口接住，保留原目录和选择，不产生未处理拒绝',async()=>{
 const {summary}=await fixture();let changes=0
 const component=mount('MarketPage.tsx'),props={...marketProps({category:'skill'},summary),contentApi:{list:async()=>[{...summary[0]!,version:'9.0.0'}],pending:()=>undefined,pendingGithubImport:()=>undefined},change:()=>{changes++}}
 component.render('TestCatalog',props);component.effects.find(fn=>fn.toString().includes('contentApi.list'))!();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(changes,0);const tree=nodes(component.render('TestCatalog',props));assert.ok(tree.some(node=>node.children.includes('market.content.directoryReadFailed')))
})

test('旧hash导航与草稿唯一时可读，歧义保留原稿且不默认采用另一固定内容',async()=>{
 const {summary,skill}=await fixture(),alias='atomic-'+skill.hash
 assert.equal(findMarketItem(summary.slice(0,1),alias),summary[0]);assert.equal(findMarketItem(summary,alias),undefined);assert.equal(matchingMarketItems(summary,alias).length,2)
 const intent={id:'legacy-draft',version:1,itemId:alias,itemVersion:'1.0.0',scope:'general',target:'workspace',purpose:'Supplied notes',visibility:'personal' as const,status:'draft' as const,createdAt,updatedAt:createdAt}
 const state={items:summary,intents:[intent]},before=structuredClone(state)
 assert.throws(()=>saveMarketIntent(state,{id:'new',itemId:alias,scope:'general',target:'workspace',purpose:'Keep notes',visibility:'personal',now:createdAt}),/不存在/)
 const unique=saveMarketIntent({items:summary.slice(0,1),intents:[]},{id:'new',itemId:alias,scope:'general',target:'workspace',purpose:'Keep notes',visibility:'personal',now:createdAt})
 assert.equal(unique.intents[0]!.itemId,fixedMarketItemId(first));assert.deepEqual(state,before)
 const opened:unknown[]=[],component=mount('MarketPage.tsx'),props={...marketProps({category:'skill'},summary),itemId:null,intentId:intent.id,state,open:(...args:unknown[])=>opened.push(args)}
 const tree=nodes(component.render('TestCatalog',props));assert.equal(tree.some(node=>node.type?.name==='MarketDetail'),false)
 const choices=tree.filter(node=>node.type==='button'&&node.children.some((text:unknown)=>typeof text==='string'&&text.includes('Notes')))
 assert.equal(choices.length,2);choices[1]!.props.onClick();assert.deepEqual(opened,[[fixedMarketItemId(second)]]);assert.deepEqual(state,before)
})

test('真实市场组件合并目录保全两固定内容，每个详情按自己的contentId打开',async()=>{
 const {summary}=await fixture();let changed:{items:typeof summary}|undefined
 const component=mount('MarketPage.tsx'),props={...marketProps({category:'skill'},[]),contentApi:{list:async()=>summary,pending:()=>undefined,pendingGithubImport:()=>undefined},change:(value:{items:typeof summary})=>{changed=value}}
 component.render('TestCatalog',props);const effect=component.effects.find(fn=>fn.toString().includes('contentApi.list'));assert.ok(effect);effect();await new Promise(resolve=>setImmediate(resolve))
 assert.deepEqual(changed?.items.map(row=>row.contentStorage?.contentId),[first,second])
 for(const target of summary){const view=mount('MarketPage.tsx'),tree=nodes(view.render('TestCatalog',{...marketProps({category:'skill'},summary),itemId:target.id})),detail=tree.find(node=>node.type?.name==='MarketDetail');assert.ok(detail);assert.equal(detail.props.item.contentStorage.contentId,target.contentStorage?.contentId)}
})

test('工作台准备函数以已知固定contentId定位草稿，旧hash同名声明不能抢占或阻断',async()=>{
 const {api,summary,skill}=await fixture(),raw={...await api.hydrate(summary[1]!),id:'atomic-'+skill.hash}
 const frame=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),body=frame.slice(frame.indexOf('const prepareMarket='),frame.indexOf('const closeCreation='))
 const marketRef={current:{items:summary,intents:[]} as Parameters<typeof saveMarketIntent>[0]},opened:string[]=[],prepared:unknown[]=[]
 const deps={marketRef,mergeMarketItems,marketItemId,saveMarketIntent,changeMarket:(value:typeof marketRef.current)=>{marketRef.current=value},t:(key:string)=>key,preparing:{current:new Map()},checkMarketTarget:()=>{throw Error('本例无授权目标')},targetsRef:{current:[]},MarketTargetCheckError:Error,work:{create:async()=>({sessionId:'prepared-session'}),getSnapshot:()=>({sessionId:'prepared-session'})},preparation:{invalidate:()=>{},prepare:(value:unknown)=>prepared.push(value)},marketPrompt:()=> 'Supplied notes only.',actions:{navigate:(value:string)=>opened.push(value)},locale:'zh-CN',localizeWorkError:(_locale:string,error:unknown)=>String(error)}
 const code=ts.transpileModule(body+';return prepareMarket;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const prepare=new Function(...Object.keys(deps),code)(...Object.values(deps)) as (item:typeof raw)=>Promise<void>
 await prepare(raw)
 assert.equal(marketRef.current.intents.length,1);assert.equal(marketRef.current.intents[0]!.itemId,fixedMarketItemId(second));assert.equal(marketRef.current.intents[0]!.preparation?.status,'ready');assert.equal(prepared.length,1);assert.deepEqual(opened,['messages'])
 assert.equal(marketRef.current.items.length,2)
})
