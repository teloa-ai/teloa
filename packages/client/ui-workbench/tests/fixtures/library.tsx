import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ResourceManager} from '../../src/client/ResourceManager.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'
const stamp='2026-10-09T00:00:00Z',hash='a'.repeat(64),docId='11111111-1111-4111-8111-111111111111',localId='22222222-2222-4222-8222-222222222222'
const doc={id:docId,ownerId:'self',title:'产品定位',sourceId:'knowledge_'+docId,sourceVersion:hash,scopeIds:['general'],status:'active',version:1,createdAt:stamp,updatedAt:stamp}
const local={...doc,id:localId,title:'发布检查.md',sourceId:'local_material_'+localId}
const root={id:'root',spaceId:'space',parentId:null,type:'space',title:'个人空间',path:['root'],siblingOrder:0,createdAt:stamp,updatedAt:stamp}
let tree:any={space:{id:'space',ownerId:'self',workspaceId:'default',title:'个人空间',rootNodeId:'root',directoryRevision:1,scopeIds:['general'],createdAt:stamp,updatedAt:stamp},nodes:[root,{...root,id:'folder',parentId:'root',type:'folder',title:'产品资料',path:['root','folder']},{...root,id:'page',parentId:'folder',type:'page',title:doc.title,path:['root','folder','page'],knowledgeId:docId}]}
const second={...doc,id:'33333333-3333-4333-8333-333333333333',title:'设计规范',sourceId:'knowledge_33333333-3333-4333-8333-333333333333'}
tree.nodes.push({...root,id:'page-2',parentId:'folder',type:'page',title:second.title,path:['root','folder','page-2'],knowledgeId:second.id,siblingOrder:1})
let resources:any[]=[doc,local,second]
const version={knowledgeId:docId,ownerId:'self',sourceId:'knowledge_'+docId,sourceType:'paste',version:1,contentHash:hash,bytes:80,createdAt:stamp,markdown:'# 产品定位\n\n帮助用户更简单地完成工作。\n\n## 使用方式\n选择相关资料，再提出目标。'}
const calls:string[]=[]
const sources:any[]=[{id:doc.sourceId,title:doc.title,source:'产品资料 / 产品定位',version:hash,bytes:80,knowledge:{knowledgeId:docId,knowledgeVersion:1,workspaceId:'default',category:'reference',topics:[],scopeIds:['general']}},{id:local.sourceId,title:local.title,source:'docs/发布检查.md',version:hash,bytes:30}]
let pauseSave=false,releaseSave:(()=>void)|undefined
let pauseWithdraw=false,releaseWithdraw:(()=>void)|undefined
let pauseDirectory=false,releaseDirectory:(()=>void)|undefined
sources.push({...sources[0],id:second.sourceId,title:second.title,source:'产品资料 / 设计规范',knowledge:{...sources[0].knowledge,knowledgeId:second.id}})
const api:any={reviseKnowledgeResource:async(input:any)=>{if(pauseSave)await new Promise<void>(resolve=>{releaseSave=resolve});return {knowledge:{version:{...version,version:2,markdown:input.markdown}},resource:{...doc,version:2}}},directory:async()=>{const captured=resources;if(pauseDirectory)await new Promise<void>(resolve=>{releaseDirectory=resolve});return {drafts:[],resources:captured}},sources:async()=>sources,knowledgeTree:async()=>tree,listKnowledgeVersions:async()=>[version],readKnowledgeVersion:async()=>version,readContent:async()=>({resource:local,text:'# 发布检查\n\n核对产物与版本。'}),createKnowledgeFolder:async(input:any)=>{const node={...root,id:'new-folder',type:'folder',parentId:input.parentId,title:input.title,path:[...tree.nodes.find((n:any)=>n.id===input.parentId).path,'new-folder']};tree={...tree,space:{...tree.space,directoryRevision:2},nodes:[...tree.nodes,node]};calls.push('folder');return {space:tree.space,node}},withdraw:async(row:any)=>{if(pauseWithdraw)await new Promise<void>(resolve=>{releaseWithdraw=resolve});resources=resources.map(r=>r.id===row.id?{...r,status:'withdrawn',version:r.version+1}:r);return resources.find(r=>r.id===row.id)}}
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},i18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
const memory=new Map<string,string>(),storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)}
function App(){const [dark,setDark]=useState(false),[navigation,setNavigation]=useState<any>({}),[identity,setIdentity]=useState(false),[mountKey,setMountKey]=useState(0),[previewNotice,setPreviewNotice]=useState('')
 const currentApi=identity?otherApi:api
 return <div className={tokens.tokens} style={{...prototypeThemes[dark?'dark':'light'],height:'100vh'} as any}><div style={{display:'flex',gap:12,height:34,alignItems:'center',padding:'0 24px',color:'var(--teloa-muted)',fontSize:12}}>开发预览 · 真实资料库组件 · 示例内容和隔离接口<button onClick={()=>setDark(!dark)}>切换主题</button>{window.location.pathname.endsWith('library-test')&&<><button onClick={()=>setIdentity(!identity)}>切换验收身份</button><button onClick={()=>setMountKey(value=>value+1)}>重载验收组件</button></>}</div><div style={{height:'calc(100vh - 34px)'}}><ResourceManager key={mountKey} api={currentApi} visible selectedDraftId={null} targetResource={null} clearTarget={()=>{}} navigationState={navigation} onNavigationChange={setNavigation} preferenceStorage={storage} openConversation={()=>{calls.push('conversation');setPreviewNotice('正式工作台会进入会话整理资料；此预览仅展示入口。')}} onUseResource={resource=>{calls.push('use:'+resource.id);setPreviewNotice('已选择《'+resource.title+'》。正式工作台会进入任务准备；此预览不会执行。')}}/>{previewNotice&&<div role="status" style={{position:'fixed',bottom:18,right:24,maxWidth:440,padding:14,border:'1px solid var(--teloa-border)',borderRadius:8,background:'var(--teloa-surface)',color:'var(--teloa-text)',boxShadow:'var(--teloa-shadow)',fontSize:13}}>{previewNotice}<button onClick={()=>setPreviewNotice('')} style={{marginLeft:10}}>关闭</button></div>}</div></div>}
const otherApi={...api,directory:async()=>({drafts:[],resources:[]}),sources:async()=>[],knowledgeTree:async()=>({...tree,space:{...tree.space,ownerId:'other',id:'other-space'},nodes:[{...root,spaceId:'other-space'}]})}
;(window as any).__libraryPauseSave=()=>{pauseSave=true}
;(window as any).__libraryReleaseSave=()=>{pauseSave=false;releaseSave?.()}
;(window as any).__libraryPauseWithdraw=()=>{pauseWithdraw=true}
;(window as any).__libraryReleaseWithdraw=()=>{pauseWithdraw=false;releaseWithdraw?.()}
;(window as any).__libraryPause=()=>{pauseDirectory=true}
;(window as any).__libraryRelease=()=>{pauseDirectory=false;releaseDirectory?.()}
;(window as any).__libraryCalls=calls
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={i18n as any}><App/></I18nProvider>)
