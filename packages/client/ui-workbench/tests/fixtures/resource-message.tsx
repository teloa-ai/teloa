import {useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import {ResourceManager} from '../../src/client/ResourceManager.js'
import {ResourceMessageDrawer} from '../../src/client/ResourceMessageDrawer.js'
import {createNativeResourceMessageApi} from '../../src/client/native-resource-message.js'
import {openResourceUsage} from '../../src/client/resource-usage-navigation.js'
import {I18nProvider} from '../../src/client/i18n/provider.js'
import type {TeloaI18n} from '../../src/client/i18n/index.js'
import {translateMessage} from '../../src/client/i18n/messages.js'
import {prototypeThemes} from '../../src/brand/prototype-theme.js'
import tokens from '../../src/client/theme-tokens.module.css'
const stamp='2026-10-21T01:00:00.000Z',ids=['11111111-1111-4111-a111-111111111111','22222222-2222-4222-a222-222222222222']
const resources=ids.map((id,index)=>({id,ownerId:'self',title:'资料'+(index+1),sourceId:'local_material_'+id,sourceVersion:'a'.repeat(64),scopeIds:['general'],status:'active',version:3,createdAt:stamp,updatedAt:stamp}))
const fixture:any={calls:[],opened:[],groups:[],pending:[],mode:'ready',released:0,writes:0};(window as any).resourceMessageFixture=fixture
const pointers=ids.map((id,index)=>({seq:12+index,messageId:'message-'+(index+1),turn:1,at:stamp,references:[{id,version:1,metadata:{title:'历史资料'+(index+1),scopeIds:['general'],sourceId:'source',sourceVersion:'b'.repeat(64)}}]})).reverse()
const body=(seq:number)=>({type:'event',event:{type:'user/message',seq,time:Date.parse(stamp),data:{id:'message-'+(seq-11),source:{kind:'user',rpcId:'original'},content:[{type:'text',text:'这是第'+(seq-11)+'条原消息\n[[teloa-resource:'+ids[seq-12]+'@1]]'}]}}})
const owner=(account:number)=>{
 let entries:any[]=[]
 const binding:any={sessionId:'original-session',eventSource:{getSnapshot:()=>({entries})},session:{sessionId:'original-session',loadThrough:async(seq:number)=>{fixture.calls.push(['loadThrough',account,seq]);if(fixture.mode==='delay')await new Promise(resolve=>fixture.pending.push(resolve));entries=[body(seq)]}}}
 return {refresh:async()=>fixture.calls.push(['refresh',account]),list:{getSnapshot:()=>({byId:{'original-session':{origin:'user'}}})},subagentAddress:()=>undefined,binding:()=>binding,using:async(id:string,_options:any,operation:any)=>{fixture.calls.push(['retain',account,id]);try{return await operation({sessionId:id,ready:Promise.resolve(binding)})}finally{fixture.released++}}} as any
}
const owners=[owner(0),owner(1)]
const sources=resources.map(row=>({id:row.sourceId,title:row.title,source:'本地验收资料',version:row.sourceVersion,bytes:1}))
const root={id:'root',spaceId:'space',parentId:null,type:'space',title:'个人空间',path:['root'],siblingOrder:0,createdAt:stamp,updatedAt:stamp}
const api:any={directory:async()=>({resources,drafts:[]}),sources:async()=>sources,knowledgeTree:async()=>({space:{id:'space',ownerId:'self',workspaceId:'default',title:'个人空间',rootNodeId:'root',directoryRevision:1,scopeIds:['general'],createdAt:stamp,updatedAt:stamp},nodes:[root]}),readContent:async(resource:any)=>({resource,text:'当前资料正文，不是历史原消息。'}),usage:async(resource:any)=>({resourceId:resource.id,version:resource.version,items:[{sessionId:'original-session',title:'原引用会话',messageId:'message-'+(ids.indexOf(resource.id)+1),at:stamp,version:1}],related:[{kind:'group',id:'33333333-3333-4333-a333-333333333333',scope:'general',title:'原引用群',messageId:'44444444-4444-4444-a444-444444444444',rootId:null,version:1,count:2}],relatedMore:false,scanned:1,unavailable:0,nextCursor:null}),history:async(sessionId:string)=>{fixture.calls.push(['history',sessionId]);if(fixture.mode==='fail-history')throw Error('History unavailable');return {sessionId,items:pointers,nextBeforeSeq:null}},withdraw:async()=>{fixture.writes++;throw Error('No writes')},create:async()=>{fixture.writes++;throw Error('No writes')},apply:async()=>{fixture.writes++;throw Error('No writes')}}
const secondApi={...api}
const snapshot={locale:'zh-CN' as const,dshLocale:'zh',revision:1},runtime:TeloaI18n={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key:any,params:any)=>translateMessage('zh-CN',key,params)}
function App(){
 const [account,setAccount]=useState(0),accountRef=useRef(account);accountRef.current=account
 const [target,setTarget]=useState({id:ids[0]!,request:1}),[source,setSource]=useState<any>(),[navigation,setNavigation]=useState({})
 const currentApi=account?secondApi:api,reader=useRef(createNativeResourceMessageApi(()=>owners[accountRef.current],api.history)).current
 fixture.select=(index:number)=>setTarget(value=>({id:ids[index]!,request:value.request+1}));fixture.connection=()=>setAccount(value=>1-value);fixture.retarget=()=>setSource((value:any)=>({...value,target:{id:'original-session',messageId:'message-2'}}))
 const ports={previewMessage:(target:any,current:any)=>setSource({target,current,account}),openConversation:async(id:string,current:any)=>{if(!current())return 'cancelled';fixture.opened.push(id);return 'opened' as const},showConversation:()=>setSource(undefined),openGroup:(...args:any[])=>fixture.groups.push(args),openTask:()=>{},openEmployee:()=>{},openProject:()=>{}}
 const sourceCurrent=()=>source&&source.account===account&&source.current()
 return <I18nProvider runtime={runtime}><div className={tokens.tokens} style={{...prototypeThemes.light,height:'100vh'} as any}><ResourceManager api={currentApi} visible selectedDraftId={null} targetResource={target} clearTarget={()=>{}} navigationState={navigation} onNavigationChange={setNavigation} openConversation={()=>{fixture.writes++}} openUsage={(target,current)=>openResourceUsage(target,current,ports)}/>{source&&sourceCurrent()&&<ResourceMessageDrawer target={source.target} api={reader} isCurrent={sourceCurrent} close={()=>setSource(undefined)} openConversation={async current=>{if(await ports.openConversation(source.target.id,()=>current()&&sourceCurrent())==='opened')ports.showConversation()}}/>}</div></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<App/> )
