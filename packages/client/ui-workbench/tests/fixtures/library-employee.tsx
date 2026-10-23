import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {createLocalMaterialRegistration} from '../../src/client/local-material-registration.js'
import {ResourceManager} from '../../src/client/ResourceManager.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'

const stamp='2026-01-01T00:00:00Z',hash='a'.repeat(64)

// 一条普通粘贴资料 + 两条员工资料
const pasteRes={id:'paste-res-1',ownerId:'self',title:'产品知识笔记',sourceId:'knowledge_paste-res-1',sourceVersion:hash,scopeIds:['general'],status:'active',version:1,createdAt:stamp,updatedAt:stamp}
const empRes1={id:'emp-know-1',ownerId:'self',title:'员工专项资料甲',sourceId:'knowledge_emp-know-1',sourceVersion:hash,scopeIds:['general'],status:'active',version:1,createdAt:stamp,updatedAt:stamp}
const empRes2={id:'emp-know-2',ownerId:'self',title:'员工专项资料乙',sourceId:'knowledge_emp-know-2',sourceVersion:hash,scopeIds:['general'],status:'active',version:1,createdAt:stamp,updatedAt:stamp}
const resources=[pasteRes,empRes1,empRes2]

const sources=[
  {id:'knowledge_paste-res-1',title:'产品知识笔记',source:'个人空间/产品知识笔记',version:hash,bytes:80,knowledge:{knowledgeId:'paste-res-1',knowledgeVersion:1,workspaceId:'default',category:'reference',topics:[],scopeIds:['general']}},
  {id:'knowledge_emp-know-1',title:'员工专项资料甲',source:'个人空间/员工专项资料甲',version:hash,bytes:60,knowledge:{knowledgeId:'emp-know-1',knowledgeVersion:1,workspaceId:'default',category:'reference',topics:[],scopeIds:['general']}},
  {id:'knowledge_emp-know-2',title:'员工专项资料乙',source:'个人空间/员工专项资料乙',version:hash,bytes:60,knowledge:{knowledgeId:'emp-know-2',knowledgeVersion:1,workspaceId:'default',category:'reference',topics:[],scopeIds:['general']}},
]

const treeRoot:any={id:'root',spaceId:'space',parentId:null,type:'space',title:'个人空间',path:['root'],siblingOrder:0,createdAt:stamp,updatedAt:stamp}
const tree={space:{id:'space',ownerId:'self',workspaceId:'default',title:'个人空间',rootNodeId:'root',directoryRevision:1,scopeIds:['general'],createdAt:stamp,updatedAt:stamp},nodes:[treeRoot]}

const api:any={
  directory:async()=>({drafts:[],resources}),
  sources:async()=>sources,
  knowledgeTree:async()=>tree,
  listKnowledgeVersions:async()=>[],
  readKnowledgeVersion:async()=>null,
  readContent:async()=>null,
  reviseKnowledgeResource:async()=>{throw Error('fixture：不支持编辑')},
  createKnowledgeFolder:async()=>{throw Error('fixture：不支持创建文件夹')},
  withdraw:async()=>{throw Error('fixture：不支持撤回')},
}
api.localMaterialRequests=createLocalMaterialRegistration(api,{read:()=>null,write:()=>{},clear:()=>{}})

// 三条角色引用：一在岗员工（引用两条资料）、一退役员工、一分身
const roleApi={
  list:async()=>[
    {id:'role-active',name:'调研助理',kind:'employee' as const,state:'active' as const,knowledge:['emp-know-1','emp-know-2']},
    {id:'role-retired',name:'前员工',kind:'employee' as const,state:'retired' as const,knowledge:['emp-know-1']},
    {id:'role-twin',name:'分身甲',kind:'twin' as const,state:'active' as const,knowledge:['emp-know-1']},
    {id:'role-writer',name:'文案员工',kind:'employee' as const,state:'active' as const,knowledge:[]},
    {id:'role-flaky',name:'客服员工',kind:'employee' as const,state:'paused' as const,knowledge:['paste-res-1']},
  ]
}

// 员工工作成果：只读元数据；客服员工的目录读取失败，只让其成果段不出现。
const output=(id:string,title:string)=>({artifactId:id,number:2,title,source:{kind:'task' as const,id:'task-'+id,scope:'general',version:'1',title:'来源任务'},createdAt:stamp,updatedAt:stamp,attribution:'task' as const})
const outputs:Record<string,ReturnType<typeof output>[]>={
  'role-active':[output('11111111-1111-4111-8111-111111111111','竞品调研结论'),output('22222222-2222-4222-8222-222222222222','无权查看的成果')],
  'role-writer':[output('33333333-3333-4333-8333-333333333333','新品发布文案')],
}
const requested:string[]=[],opened:string[]=[]
Object.assign(window,{__libraryOutputs:{requested,opened}})
const enrolled:string[]=[]
const retrievalApi:any={modelStatus:async()=>({enabled:true,provider:{id:'qwen',location:'host-local',catalogId:'fixture',catalogVersion:'1',profileHash:'a'.repeat(64),variant:'fp32',totalMemoryBytes:1,memoryRisk:false,preparation:{phase:'ready'}},building:false,guidance:null}),status:async()=>({items:[],enrolled:0,chunks:0,building:false}),enroll:async(sourceId:string)=>{enrolled.push(sourceId);return {items:[],enrolled:enrolled.length,chunks:0,building:false}},remove:async()=>({items:[],enrolled:0,chunks:0,building:false}),reindex:async()=>({items:[],enrolled:0,chunks:0,building:false}),cancel:async()=>({items:[],enrolled:0,chunks:0,building:false}),prepare:async()=>({enabled:true,provider:null,building:false,guidance:null}),cancelPreparation:async()=>({enabled:true,provider:null,building:false,guidance:null}),select:async()=>({enabled:true,provider:null,building:false,guidance:null})}
Object.assign(window,{__retrievalEnrolled:enrolled})
const artifactApi={listByRole:async(roleId:string)=>{requested.push(roleId);if(roleId==='role-flaky')throw Error('fixture：成果目录暂不可用');return outputs[roleId]??[]}}
const openArtifact=async(item:{artifactId:string})=>{opened.push(item.artifactId);if(item.artifactId.startsWith('2222'))throw Object.assign(Error('forbidden'),{code:'teloa/forbidden'})}

const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1}
const i18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
const memory=new Map<string,string>()
const storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)}

function App(){
  const [navigation,setNavigation]=useState<any>({})
  return <div className={tokens.tokens} style={{...prototypeThemes.light,height:'100vh'} as any}>
    <ResourceManager api={api} roleApi={roleApi} artifactApi={artifactApi} localRetrievalApi={retrievalApi} openArtifact={openArtifact} visible selectedDraftId={null} targetResource={null} clearTarget={()=>{}} navigationState={navigation} onNavigationChange={setNavigation} preferenceStorage={storage} openConversation={()=>{}} onUseResource={()=>{}}/>
  </div>
}
createRoot(document.getElementById('root')!).render(<I18nProvider runtime={i18n as any}><App/></I18nProvider>)
