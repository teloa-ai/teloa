import {isLocalMaterialSourceId} from './local-material-registration.js'
import {LocalRetrievalResources} from './LocalRetrievalResources.js'
import type {LocalRetrievalApi} from './local-retrieval-api.js'
import { useEffect,useRef,useState,type ReactNode } from 'react'
import { ChevronDown,FileText,Folder,FolderInput,FolderPlus,MessageSquare,MoreHorizontal,Pencil,RefreshCw,Search } from 'lucide-react'
import { encodeResourceReference,type KnowledgeTree,type ResourceDirectory,type ResourceDraft,type SourceReference,type WorkResource } from '@teloa/contract'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { isResourceDraft } from '@teloa/contract'
import type { ResourceApi } from './resource-api.js'
import {KnowledgeDocument} from './KnowledgeDocument.js'
import { useDirectoryFocus } from './directory-focus.js'
import { libraryResourceDirectory,buildKnowledgeDirectoryTree,canGovernKnowledgeNode,defaultKnowledgeSelection,defaultResourceSelection,filterResourceManagerDirectory,knowledgeBreadcrumbs,knowledgeMoveTargets,normalizeResourceSourceSelection,resourceSourceFacts,type KnowledgeDirectoryBranch,type KnowledgeDirectoryPage,type KnowledgeWikiDocument,type ResourceManagerFilters } from './resource-manager-presentation.js'
import css from './ResourceManager.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

export type ResourceManagerNavigationState={query:string;category:NonNullable<ResourceManagerFilters['category']>;selectedId:string|undefined;mobileLayer:'directory'|'detail'}

export function ResourceManager({localRetrievalApi,api,visible,selectedDraftId,targetResource,clearTarget,openConversation,onExtensions,navigationState,onNavigationChange}:{localRetrievalApi?:LocalRetrievalApi|undefined;api:ResourceApi;visible:boolean;selectedDraftId:string|null;targetResource:{id:string;request:number}|null;clearTarget:()=>void;openConversation:()=>void;onExtensions?:(()=>void)|undefined;navigationState?:Partial<ResourceManagerNavigationState>;onNavigationChange?:(state:ResourceManagerNavigationState)=>void}){
  const {locale,t}=useI18n()
  const [directory,setDirectory]=useState<ResourceDirectory>({drafts:[],resources:[]}),[sources,setSources]=useState<SourceReference[]>([]),[knowledgeTree,setKnowledgeTree]=useState<KnowledgeTree>()
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>()
  const [query,setQuery]=useState(navigationState?.query??'')
  const [mobileDetailOpen,setMobileDetailOpen]=useState(navigationState?.mobileLayer==='detail')
  const [editing,setEditing]=useState<ResourceDraft>(),[selectedResourceId,setSelectedResourceId]=useState<string|undefined>(navigationState?.selectedId),[title,setTitle]=useState(''),[sourceId,setSourceId]=useState(''),[sourceVersion,setSourceVersion]=useState('')
  const [selectedNodeId,setSelectedNodeId]=useState<string|undefined>(navigationState?.selectedId),[creatingFolder,setCreatingFolder]=useState(false),[folderTitle,setFolderTitle]=useState('')
  const [tracking,setTracking]=useState(false),[localTitle,setLocalTitle]=useState(''),[localPath,setLocalPath]=useState(''),localRequests=api.localMaterialRequests
  const [governanceAction,setGovernanceAction]=useState<'rename'|'move'>(),[governanceTitle,setGovernanceTitle]=useState(''),[moveParentId,setMoveParentId]=useState('')
  const requestId=useRef(crypto.randomUUID()),folderRequest=useRef<{requestId:string;parentId:string;title:string;expectedDirectoryRevision:number}>(),governanceRequest=useRef<{requestId:string;operation:'rename'|'move';nodeId:string;value:string;expectedDirectoryRevision:number}>(),loadGeneration=useRef(0),formGeneration=useRef(0),handledDraft=useRef<string|null>(null),restoredSelection=useRef(navigationState?.selectedId)
  const rememberNavigation=(patch:Partial<ResourceManagerNavigationState>)=>onNavigationChange?.({query,category:'all',selectedId:editing?.id??selectedNodeId??selectedResourceId,mobileLayer:mobileDetailOpen?'detail':'directory',...patch})
  const select=(draft:ResourceDraft)=>{formGeneration.current++;setTracking(false);setEditing(draft);setSelectedResourceId(undefined);setSelectedNodeId(knowledgeTree?.space.rootNodeId);setTitle(draft.title);setSourceId(draft.sourceId);setSourceVersion(draft.sourceVersion);requestId.current=crypto.randomUUID();setError(undefined);setNotice(undefined);rememberNavigation({selectedId:draft.id})}
  const inspectResource=(resource:WorkResource)=>{formGeneration.current++;setTracking(false);setEditing(undefined);setSelectedResourceId(resource.id);setError(undefined);setNotice(undefined);rememberNavigation({selectedId:resource.id})}
  const pageNodeFor=(resource:WorkResource,tree:KnowledgeTree,available:SourceReference[])=>{
    const knowledgeId=available.find(source=>source.id===resource.sourceId)?.knowledge?.knowledgeId??(resource.sourceId.startsWith('knowledge_')?resource.sourceId.slice('knowledge_'.length):undefined)
    return knowledgeId?tree.nodes.find(node=>node.type==='page'&&node.knowledgeId===knowledgeId):undefined
  }
  const refresh=async()=>{
    const generation=++loadGeneration.current;setLoading(true)
    try{
      const [rows,available,tree]=await Promise.all([api.directory(),api.sources(),api.knowledgeTree()])
      if(generation!==loadGeneration.current)return
      setDirectory(rows);setSources(available);setKnowledgeTree(tree)
      const knowledgeRows=libraryResourceDirectory(rows,available)
      const restoredId=restoredSelection.current
      restoredSelection.current=undefined
      const restoredDraft=knowledgeRows.drafts.find(row=>row.id===restoredId),restoredResource=rows.resources.find(row=>row.id===restoredId||!editing&&row.id===selectedResourceId&&isLocalMaterialSourceId(row.sourceId)),restoredNode=tree.nodes.find(row=>row.id===restoredId)
      let restoredNextId:string|undefined
      if(restoredDraft){restoredNextId=restoredDraft.id;setEditing(restoredDraft);setSelectedResourceId(undefined);setSelectedNodeId(tree.space.rootNodeId);setTitle(restoredDraft.title);setSourceId(restoredDraft.sourceId);setSourceVersion(restoredDraft.sourceVersion)}
      else if(restoredResource){restoredNextId=restoredResource.id;setEditing(undefined);setSelectedResourceId(restoredResource.id);setSelectedNodeId(pageNodeFor(restoredResource,tree,available)?.id??tree.space.rootNodeId)}
      else{const selection=defaultKnowledgeSelection(tree,knowledgeRows,available,restoredNode?.id??selectedNodeId);restoredNextId=restoredNode?.id??selection.resourceId??selection.nodeId;setSelectedNodeId(selection.nodeId);if(!editing)setSelectedResourceId(selection.resourceId)}
      if(restoredId&&restoredNextId!==restoredId)rememberNavigation({selectedId:restoredNextId,mobileLayer:restoredNextId?'detail':'directory'})
      if(!restoredDraft){const normalized=normalizeResourceSourceSelection(available,sourceId,sourceVersion);if(normalized.id!==sourceId)setSourceId(normalized.id);if(normalized.version!==sourceVersion)setSourceVersion(normalized.version)}
      if(targetResource){const resource=rows.resources.find(row=>row.id===targetResource.id);if(resource){inspectResource(resource);setSelectedNodeId(pageNodeFor(resource,tree,available)?.id??tree.space.rootNodeId);setMobileDetailOpen(true);rememberNavigation({selectedId:resource.id,mobileLayer:'detail'})}else{setError(t('knowledge.manager.notFound'));clearTarget()}}
    }
    catch(cause){if(generation===loadGeneration.current)setError(localizeWorkError(locale,cause))}
    finally{if(generation===loadGeneration.current)setLoading(false)}
  }
  useEffect(()=>{if(visible)void refresh();return ()=>{loadGeneration.current++}},[visible,api,targetResource?.request])
  useEffect(()=>{if(targetResource&&selectedResourceId===targetResource.id)clearTarget()},[targetResource?.request,selectedResourceId,clearTarget])
  useEffect(()=>{
    if(!selectedDraftId){handledDraft.current=null;return}
    if(handledDraft.current===selectedDraftId)return
    const draft=directory.drafts.find(row=>row.id===selectedDraftId)
    if(!draft)return
    handledDraft.current=selectedDraftId
    if(draft.status==='applied'&&draft.resourceId){
      const resource=directory.resources.find(row=>row.id===draft.resourceId)
      if(resource){inspectResource(resource);setMobileDetailOpen(true);rememberNavigation({selectedId:resource.id,mobileLayer:'detail'})}
      return
    }
    select(draft);setMobileDetailOpen(true);rememberNavigation({selectedId:draft.id,mobileLayer:'detail'})
  },[selectedDraftId,directory])
  useEffect(()=>{const prior=localRequests?.pending();if(visible&&prior){setLocalTitle(prior.title);setLocalPath(prior.path);setTracking(true)}},[visible,api])
  const knowledgeDirectory=libraryResourceDirectory(directory,sources)
  const selectedSource=sources.find(source=>source.id===sourceId)
  const dirty=editing?title!==editing.title||sourceId!==editing.sourceId||sourceVersion!==editing.sourceVersion:true
  const save=async()=>{
    const generation=formGeneration.current;setBusy(true);setError(undefined);setNotice(undefined)
    const fields={title,sourceId,sourceVersion,scopeIds:['general']}
    try{
      const draft=editing?await api.update({...fields,draftId:editing.id,expectedVersion:editing.version}):await api.create({...fields,requestId:requestId.current})
      if(generation===formGeneration.current){select(draft);setNotice(t('knowledge.manager.saved'))}
      await refresh()
    }catch(cause){if(generation===formGeneration.current)setError(localizeWorkError(locale,cause))}finally{setBusy(false)}
  }
  const trackFile=async(recover=false)=>{
    if(!localRequests||busy)return
    const generation=formGeneration.current;setBusy(true);setError(undefined);setNotice(undefined)
    try{
      const draft=await (recover?localRequests.recover():localRequests.begin({title:localTitle.trim(),path:localPath.trim(),scopeIds:['general']}))
      if(generation===formGeneration.current){restoredSelection.current=draft.id;select(draft);setMobileDetailOpen(true);rememberNavigation({selectedId:draft.id,mobileLayer:'detail'});setNotice(t('knowledge.local.ready'))}
      await refresh()
    }catch(cause){if(generation===formGeneration.current)setError(localizeWorkError(locale,cause))}finally{setBusy(false)}
  }
  const apply=async()=>{
    if(!editing)return
    const generation=formGeneration.current;setBusy(true);setError(undefined)
    try{const applied=await api.apply(editing);const rows=await api.directory();setDirectory(rows);if(generation===formGeneration.current){inspectResource(applied);setNotice(t('knowledge.manager.applied'))}}
    catch(cause){if(generation===formGeneration.current)setError(localizeWorkError(locale,cause))}finally{setBusy(false)}
  }
  const withdraw=async(resource:WorkResource)=>{
    setBusy(true);setError(undefined)
    try{await api.withdraw(resource);setNotice(t('knowledge.manager.withdrawn'));await refresh()}
    catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}
  }
  const copy=async(resource:WorkResource)=>{try{await navigator.clipboard.writeText(encodeResourceReference(resource));setNotice(t('knowledge.manager.copied'))}catch{setError(t('knowledge.manager.copyFailed'))}}
  const selectedNode=knowledgeTree?.nodes.find(node=>node.id===selectedNodeId),selectedFolder=selectedNode?.type==='folder'||selectedNode?.type==='space'?selectedNode:knowledgeTree?.nodes.find(node=>node.id===selectedNode?.parentId),folderParentId=selectedFolder?.id??knowledgeTree?.space.rootNodeId
  const createFolder=async()=>{
    const value=folderTitle.trim()
    if(!knowledgeTree||!folderParentId||!value)return
    const prior=folderRequest.current,attempt=prior&&prior.parentId===folderParentId&&prior.title===value?prior:{requestId:crypto.randomUUID(),parentId:folderParentId,title:value,expectedDirectoryRevision:knowledgeTree.space.directoryRevision}
    folderRequest.current=attempt;setBusy(true);setError(undefined);setNotice(undefined)
    try{await api.createKnowledgeFolder(attempt);folderRequest.current=undefined;setFolderTitle('');setCreatingFolder(false);setNotice(t('knowledge.manager.folderCreated',{name:selectedFolder?.title??knowledgeTree.space.title}));await refresh()}
    catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}
  }
  const renameNode=async()=>{
    const value=governanceTitle.trim()
    if(!knowledgeTree||!selectedNode||!canGovernKnowledgeNode(knowledgeTree,selectedNode.id)||!value)return
    const prior=governanceRequest.current,attempt=prior&&prior.operation==='rename'&&prior.nodeId===selectedNode.id&&prior.value===value?prior:{requestId:crypto.randomUUID(),operation:'rename' as const,nodeId:selectedNode.id,value,expectedDirectoryRevision:knowledgeTree.space.directoryRevision}
    governanceRequest.current=attempt;setBusy(true);setError(undefined);setNotice(undefined)
    try{await api.renameKnowledgeNode({requestId:attempt.requestId,nodeId:attempt.nodeId,title:attempt.value,expectedDirectoryRevision:attempt.expectedDirectoryRevision});governanceRequest.current=undefined;setGovernanceAction(undefined);setNotice(t('knowledge.manager.renamed'));await refresh()}
    catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}
  }
  const moveNode=async()=>{
    if(!knowledgeTree||!selectedNode||!canGovernKnowledgeNode(knowledgeTree,selectedNode.id)||!moveParentId)return
    const prior=governanceRequest.current,attempt=prior&&prior.operation==='move'&&prior.nodeId===selectedNode.id&&prior.value===moveParentId?prior:{requestId:crypto.randomUUID(),operation:'move' as const,nodeId:selectedNode.id,value:moveParentId,expectedDirectoryRevision:knowledgeTree.space.directoryRevision}
    governanceRequest.current=attempt;setBusy(true);setError(undefined);setNotice(undefined)
    try{await api.moveKnowledgeNode({requestId:attempt.requestId,nodeId:attempt.nodeId,parentId:attempt.value,expectedDirectoryRevision:attempt.expectedDirectoryRevision});governanceRequest.current=undefined;setGovernanceAction(undefined);setNotice(t('knowledge.manager.moved'));await refresh()}
    catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}
  }
  const visibleDirectory=filterResourceManagerDirectory(knowledgeDirectory,'',sources),visiblePending=filterResourceManagerDirectory(knowledgeDirectory,query,sources).drafts,visibleResources=visibleDirectory.resources,selectedResource=directory.resources.find(resource=>resource.id===selectedResourceId),directoryTree=knowledgeTree?buildKnowledgeDirectoryTree(knowledgeTree,knowledgeDirectory,sources,query):undefined,breadcrumbs=knowledgeTree?knowledgeBreadcrumbs(knowledgeTree,selectedNodeId??knowledgeTree.space.rootNodeId):[],knowledgeCount=knowledgeDirectory.drafts.length+(knowledgeTree?buildKnowledgeDirectoryTree(knowledgeTree,knowledgeDirectory,sources).count:0)+knowledgeDirectory.resources.filter(row=>isLocalMaterialSourceId(row.sourceId)).length,selectedNodePageCount=knowledgeTree&&selectedNode?knowledgeTree.nodes.filter(node=>node.type==='page'&&node.path.includes(selectedNode.id)).length:0
  const moveTargets=knowledgeTree&&selectedNode?knowledgeMoveTargets(knowledgeTree,selectedNode.id):[]
  useEffect(()=>{
    if(!knowledgeTree)return
    const draftVisible=!!editing&&visiblePending.some(row=>row.id===editing.id),resourceVisible=!!selectedResource&&visibleResources.some(row=>row.id===selectedResource.id)
    if(draftVisible||resourceVisible||selectedNode?.type==='folder'||selectedNode?.type==='space'||selectedNode?.type==='page'&&!selectedResource)return
    const next=defaultResourceSelection(visibleDirectory)
    if(next?.kind==='draft'){select(next.draft);return}
    if(next?.kind==='resource'){inspectResource(next.resource);return}
    setEditing(undefined);setSelectedResourceId(undefined);setMobileDetailOpen(false);rememberNavigation({selectedId:undefined,mobileLayer:'directory'})
  },[knowledgeTree,directory,sources,editing?.id,selectedResourceId,selectedNode?.id])
  const localResources=filterResourceManagerDirectory(knowledgeDirectory,query,sources).resources.filter(row=>isLocalMaterialSourceId(row.sourceId))
  const directoryFocus=useDirectoryFocus(visible,mobileDetailOpen?(editing?.id??selectedNodeId??selectedResourceId):undefined)
  return <section className={css.page} data-mobile-detail={mobileDetailOpen?'open':'directory'} hidden={!visible} aria-label={t('knowledge.manager.title')}>
    {error&&<p className={css.message} role="alert">{error}</p>}{notice&&<p className={css.message} role="status">{notice}</p>}
    {localRetrievalApi&&<div className={css.retrieval}><LocalRetrievalResources api={localRetrievalApi} resource={selectedResource} visible={visible} onExtensions={onExtensions}/></div>}
    <div {...directoryFocus} className={css.workspace}>
      <WikiKnowledgeTree
        tree={directoryTree}
        query={query}
        onQueryChange={value=>{setQuery(value);rememberNavigation({query:value})}}
        drafts={visiblePending.map(draft=>({id:draft.id,title:draft.title,kind:'draft' as const,status:'draft' as const}))}
        localResources={localResources.map(resource=>({id:resource.id,title:resource.title,kind:'resource' as const,status:resource.status}))}
        selectResource={id=>{const resource=directory.resources.find(row=>row.id===id);if(resource){inspectResource(resource);setSelectedNodeId(knowledgeTree?.space.rootNodeId);setMobileDetailOpen(true);rememberNavigation({selectedId:id,mobileLayer:'detail'})}}}
        trackLocal={localRequests?()=>{setTracking(true);setEditing(undefined);setSelectedResourceId(undefined);setMobileDetailOpen(true);setError(undefined)}:undefined}
        selectedDraftId={editing?.id}
        selectedResourceId={selectedResource?.id}
        selectedNodeId={selectedNodeId}
        selectDraft={id=>{const draft=directory.drafts.find(row=>row.id===id);if(draft){select(draft);setMobileDetailOpen(true);rememberNavigation({selectedId:draft.id,mobileLayer:'detail'})}}}
        selectPage={page=>{setSelectedNodeId(page.id);setEditing(undefined);const resource=directory.resources.find(row=>row.id===page.resourceId);setSelectedResourceId(resource?.id);setError(undefined);setNotice(undefined);setMobileDetailOpen(true);rememberNavigation({selectedId:page.id,mobileLayer:'detail'})}}
        selectFolder={id=>{setSelectedNodeId(id);setEditing(undefined);setSelectedResourceId(undefined);setMobileDetailOpen(true);rememberNavigation({selectedId:id,mobileLayer:'detail'})}}
        openConversation={openConversation}
        refresh={()=>void refresh()}
        refreshing={loading||busy}
        creatingFolder={creatingFolder}
        folderTitle={folderTitle}
        folderTarget={selectedFolder?.title??knowledgeTree?.space.title??t('knowledge.manager.title')}
        startFolder={()=>setCreatingFolder(true)}
        cancelFolder={()=>{setCreatingFolder(false);setFolderTitle('');folderRequest.current=undefined}}
        setFolderTitle={value=>{setFolderTitle(value);if(folderRequest.current?.title!==value.trim())folderRequest.current=undefined}}
        createFolder={()=>void createFolder()}
        governance={knowledgeTree&&selectedNode&&canGovernKnowledgeNode(knowledgeTree,selectedNode.id)?<KnowledgeGovernance nodeTitle={selectedNode.title} action={governanceAction} title={governanceTitle} moveParentId={moveParentId} moveTargets={moveTargets} busy={busy} startRename={()=>{setGovernanceAction('rename');setGovernanceTitle(selectedNode.title);setMoveParentId('');governanceRequest.current=undefined}} startMove={()=>{setGovernanceAction('move');setMoveParentId(moveTargets[0]?.id??'');setGovernanceTitle('');governanceRequest.current=undefined}} changeTitle={value=>{setGovernanceTitle(value);if(governanceRequest.current?.value!==value.trim())governanceRequest.current=undefined}} changeMoveParent={value=>{setMoveParentId(value);if(governanceRequest.current?.value!==value)governanceRequest.current=undefined}} cancel={()=>{setGovernanceAction(undefined);governanceRequest.current=undefined}} rename={()=>void renameNode()} move={()=>void moveNode()}/>:undefined}
      />
      <main data-teloa-pane="detail" tabIndex={-1} className={css.detail} aria-label={t('knowledge.manager.detailAria')}><button type="button" className={css.mobileBack} onClick={()=>{setMobileDetailOpen(false);rememberNavigation({mobileLayer:'directory'})}}>{t('knowledge.manager.back')}</button>{breadcrumbs.length>0&&<nav className={css.breadcrumbs} aria-label={t('knowledge.manager.breadcrumbAria')}>{breadcrumbs.map((item,index)=><span key={item.id}>{index>0&&<i>/</i>}<button type="button" aria-current={item.id===selectedNodeId?'page':undefined} onClick={()=>{if(item.type!=='page'){setSelectedNodeId(item.id);setEditing(undefined);setSelectedResourceId(undefined);rememberNavigation({selectedId:item.id})}}}>{item.title}</button></span>)}</nav>}{tracking&&localRequests?<form className={css.editor} onSubmit={event=>{event.preventDefault();void trackFile()}}><h2>{t('knowledge.local.track')}</h2><p className={css.muted}>{t('knowledge.local.boundary')}</p><fieldset disabled={busy||!!localRequests.pending()||!!localRequests.recoveryMessage()}><label>{t('knowledge.manager.name')}<input autoFocus required maxLength={200} value={localTitle} onChange={event=>setLocalTitle(event.target.value)}/></label><label>{t('knowledge.local.path')}<input required maxLength={4096} value={localPath} onChange={event=>setLocalPath(event.target.value)}/></label><div className={css.actions}><button type="button" className={css.button} onClick={()=>setTracking(false)}>{t('knowledge.manager.cancel')}</button><button type="submit" className={css.primaryButton} disabled={!localTitle.trim()||!localPath.trim()}>{t('knowledge.local.save')}</button></div></fieldset>{localRequests.recoveryMessage()&&<p role="alert">{localizeWorkError(locale,localRequests.recoveryMessage())}</p>}{localRequests.pending()&&<div className={css.actions}><p>{t('knowledge.local.unknown')}</p><button type="button" className={css.button} disabled={busy} onClick={()=>void trackFile(true)}>{t('knowledge.local.recover')}</button></div>}{localRequests.recoveryMessage()&&<button type="button" className={css.button} disabled={busy} onClick={()=>{localRequests.discard();setError(undefined)}}>{t('recovery.discard')}</button>}</form>:editing?<form className={css.editor} onSubmit={event=>{event.preventDefault();void save()}}><h2>{t('knowledge.manager.editTitle')}</h2><fieldset disabled={busy||editing.status==='applied'}><label>{t('knowledge.manager.name')}<input value={title} maxLength={200} required onChange={event=>setTitle(event.target.value)}/></label><label>{t('knowledge.manager.source')}<select value={sourceId} required onChange={event=>{setSourceId(event.target.value);setSourceVersion(sources.find(source=>source.id===event.target.value)?.version??'')}}><option value="">{t('knowledge.manager.selectSource')}</option>{sources.map(source=><option key={source.id} value={source.id}>{source.title}</option>)}</select></label><label>{t('knowledge.manager.scope')}<input value={t('knowledge.manager.generalScope')} readOnly/></label><label>{t('knowledge.manager.currentVersion')}<output className={css.version}>{sourceVersion||t('knowledge.manager.noVersion')}</output></label>{selectedSource&&sourceVersion!==selectedSource.version&&<button type="button" className={css.button} onClick={()=>setSourceVersion(selectedSource.version)}>{t('knowledge.manager.useLatest')}</button>}<div className={css.actions}><button type="submit" className={css.button} disabled={!title.trim()||!sourceId||!sourceVersion||!dirty}>{t('knowledge.manager.save')}</button><button type="button" className={css.primaryButton} disabled={dirty} onClick={()=>void apply()}>{t('knowledge.manager.apply')}</button></div></fieldset><details className={css.moreFacts}><summary>{t('knowledge.manager.sourceFacts')}</summary><dl className={css.governanceFacts}>{resourceSourceFacts(selectedSource).map(([term,value])=><div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl></details>{editing.status==='applied'?<p className={css.muted}>{t('knowledge.manager.appliedNote')}</p>:dirty&&<p className={css.muted}>{t('knowledge.manager.unsavedNote')}</p>}</form>:selectedResource?<><p className={css.muted}>{isLocalMaterialSourceId(selectedResource.sourceId)?sources.find(source=>source.id===selectedResource.sourceId)?.source:null}</p><KnowledgeDocument api={api} resource={selectedResource} source={sources.find(source=>source.id===selectedResource.sourceId)} onPublished={async resourceId=>{await refresh();setSelectedResourceId(resourceId)}} onCopy={()=>void copy(selectedResource)} onWithdraw={()=>void withdraw(selectedResource)} onNotice={setNotice} onError={setError}/></>:selectedNode?.type==='page'?<section className={css.folderDetail}><FileText size={28}/><h2>{selectedNode.title}</h2><p>{t('knowledge.manager.bodyUnavailable')}</p></section>:selectedNode&&(selectedNode.type==='folder'||selectedNode.type==='space')?<section className={css.folderDetail}><Folder size={28}/><h2>{selectedNode.title}</h2><p>{selectedNode.type==='space'?t('knowledge.manager.spaceDescription'):t('knowledge.manager.folderPages',{count:selectedNodePageCount})}</p><button type="button" className={css.button} onClick={()=>setCreatingFolder(true)}><FolderPlus size={15}/>{t('knowledge.manager.newFolder')}</button></section>:<section className={css.emptyDetail}><h2>{t(knowledgeCount===0?'knowledge.manager.emptyTitle':'knowledge.manager.selectTitle')}</h2><p>{t(knowledgeCount===0?'knowledge.manager.emptyDescription':'knowledge.manager.selectDescription')}</p>{knowledgeCount===0&&<button type="button" className={css.primaryButton} onClick={openConversation}>{t('knowledge.manager.openConversation')}</button>}</section>}</main>
    </div>
  </section>
}

function KnowledgeGovernance({nodeTitle,action,title,moveParentId,moveTargets,busy,startRename,startMove,changeTitle,changeMoveParent,cancel,rename,move}:{nodeTitle:string;action:'rename'|'move'|undefined;title:string;moveParentId:string;moveTargets:{id:string;label:string}[];busy:boolean;startRename:()=>void;startMove:()=>void;changeTitle:(value:string)=>void;changeMoveParent:(value:string)=>void;cancel:()=>void;rename:()=>void;move:()=>void}){
  const {t}=useI18n()
  return <section className={css.governance} aria-label={t('knowledge.manager.manageAria',{name:nodeTitle})}>{!action&&<details className={css.governanceMenu}><summary aria-label={t('knowledge.manager.manageAria',{name:nodeTitle})}><MoreHorizontal size={18}/></summary><div><button type="button" onClick={startRename}><Pencil size={14}/>{t('knowledge.manager.rename')}</button><button type="button" disabled={!moveTargets.length} onClick={startMove}><FolderInput size={14}/>{t('knowledge.manager.move')}</button></div></details>}{action==='rename'&&<form onSubmit={event=>{event.preventDefault();rename()}}><label>{t('knowledge.manager.name')}<input autoFocus value={title} maxLength={200} required onChange={event=>changeTitle(event.target.value)}/></label><div><button type="button" onClick={cancel}>{t('knowledge.manager.cancel')}</button><button type="submit" disabled={busy||!title.trim()||title.trim()===nodeTitle}>{t('knowledge.manager.rename')}</button></div></form>}{action==='move'&&<form onSubmit={event=>{event.preventDefault();move()}}><label>{t('knowledge.manager.move')}<select autoFocus value={moveParentId} required onChange={event=>changeMoveParent(event.target.value)}>{moveTargets.map(target=><option key={target.id} value={target.id}>{target.label}</option>)}</select></label><div><button type="button" onClick={cancel}>{t('knowledge.manager.cancel')}</button><button type="submit" disabled={busy||!moveParentId}>{t('knowledge.manager.move')}</button></div></form>}</section>
}

function WikiDocumentRow({document,selected,onSelect}:{document:KnowledgeWikiDocument;selected:boolean;onSelect:(id:string)=>void}){
  const {t}=useI18n()
  const exceptionalStatus=document.status==='draft'?t('knowledge.manager.statusDraft'):document.status==='withdrawn'?t('knowledge.manager.statusWithdrawn'):undefined
  return <button type="button" data-teloa-entry={document.id} className={css.treeDocument} aria-current={selected?'page':undefined} onClick={()=>onSelect(document.id)}><FileText size={14}/><span><strong>{document.title}</strong>{exceptionalStatus&&<small>{exceptionalStatus}</small>}</span></button>
}

function KnowledgePageRow({page,selected,onSelect}:{page:KnowledgeDirectoryPage;selected:boolean;onSelect:(page:KnowledgeDirectoryPage)=>void}){
  const {t}=useI18n()
  const exceptionalStatus=page.status==='withdrawn'?t('knowledge.manager.statusWithdrawn'):page.status==='unavailable'?t('knowledge.manager.statusUnavailable'):undefined
  return <button type="button" data-teloa-entry={page.id} className={css.treeDocument} aria-current={selected?'page':undefined} disabled={page.status==='unavailable'} onClick={()=>onSelect(page)}><FileText size={14}/><span><strong>{page.title}</strong>{exceptionalStatus&&<small>{exceptionalStatus}</small>}</span></button>
}

function KnowledgeBranch({branch,selectedNodeId,selectFolder,selectPage}:{branch:KnowledgeDirectoryBranch;selectedNodeId:string|undefined;selectFolder:(id:string)=>void;selectPage:(page:KnowledgeDirectoryPage)=>void}){
  return <details className={css.treeBranch} open><summary data-teloa-entry={branch.id} aria-current={selectedNodeId===branch.id?'page':undefined} onClick={()=>selectFolder(branch.id)}><ChevronDown size={14}/><Folder size={15}/><strong>{branch.title}</strong><small>{branch.count}</small></summary><div className={css.treeGroup}>{branch.children.map(child=>child.type==='page'?<KnowledgePageRow key={child.id} page={child} selected={selectedNodeId===child.id} onSelect={selectPage}/>:<KnowledgeBranch key={child.id} branch={child} selectedNodeId={selectedNodeId} selectFolder={selectFolder} selectPage={selectPage}/>)}</div></details>
}

function WikiKnowledgeTree({localResources,selectResource,trackLocal,tree,query,onQueryChange,drafts,selectedDraftId,selectedResourceId,selectedNodeId,selectDraft,selectPage,selectFolder,openConversation,refresh,refreshing,creatingFolder,folderTitle,folderTarget,startFolder,cancelFolder,setFolderTitle,createFolder,governance}:{
  localResources:KnowledgeWikiDocument[];selectResource:(id:string)=>void;trackLocal:(()=>void)|undefined
  query:string;onQueryChange:(value:string)=>void
  tree:KnowledgeDirectoryBranch|undefined;drafts:KnowledgeWikiDocument[];selectedDraftId:string|undefined;selectedResourceId:string|undefined;selectedNodeId:string|undefined
  selectDraft:(id:string)=>void;selectPage:(page:KnowledgeDirectoryPage)=>void;selectFolder:(id:string)=>void;openConversation:()=>void
  refresh:()=>void;refreshing:boolean;creatingFolder:boolean;folderTitle:string;folderTarget:string
  startFolder:()=>void;cancelFolder:()=>void;setFolderTitle:(value:string)=>void;createFolder:()=>void
  governance:ReactNode
}){
  const {t}=useI18n()
  const count=drafts.length+(tree?.count??0)+localResources.length
  return <aside data-teloa-pane="directory" tabIndex={-1} className={css.taxonomy} aria-label={t('knowledge.directory')}>
    <header className={css.treeHeader}><h2>{t('knowledge.manager.title')}</h2><div>{trackLocal&&<button type="button" title={t('knowledge.local.track')} aria-label={t('knowledge.local.track')} disabled={refreshing} onClick={trackLocal}><FileText size={16}/></button>}<button type="button" title={t('knowledge.manager.newFolder')} aria-label={t('knowledge.manager.newFolder')} disabled={!tree||refreshing} onClick={startFolder}><FolderPlus size={16}/></button><button type="button" title={t('knowledge.manager.openConversation')} aria-label={t('knowledge.manager.openConversation')} onClick={openConversation}><MessageSquare size={16}/></button><button type="button" title={t('knowledge.refresh')} aria-label={t('knowledge.refresh')} disabled={refreshing} onClick={refresh}><RefreshCw size={16}/></button>{governance}</div></header>
    <label className={css.treeSearch}><Search size={15}/><input type="search" aria-label={t('knowledge.manager.search')} placeholder={t('knowledge.manager.search')} value={query} onChange={event=>onQueryChange(event.target.value)}/></label>
    {creatingFolder&&<form className={css.folderForm} onSubmit={event=>{event.preventDefault();createFolder()}}><span>{t('knowledge.manager.folderTarget',{name:folderTarget})}</span><input autoFocus value={folderTitle} maxLength={200} required placeholder={t('knowledge.manager.folderName')} onChange={event=>setFolderTitle(event.target.value)}/><div><button type="button" onClick={cancelFolder}>{t('knowledge.manager.cancel')}</button><button type="submit" disabled={refreshing||!folderTitle.trim()}>{t('knowledge.manager.newFolder')}</button></div></form>}
    <nav className={css.wikiTree} aria-label={t('knowledge.directory')}>
      {drafts.length>0&&<details className={css.treeBranch} open><summary><ChevronDown size={14}/><Folder size={15}/><strong>{t('knowledge.manager.drafts')}</strong><small>{drafts.length}</small></summary><div className={css.treeGroup}>{drafts.map(document=><WikiDocumentRow key={document.id} document={document} selected={selectedDraftId===document.id} onSelect={selectDraft}/>)}</div></details>}
      {localResources.length>0&&<details className={css.treeBranch} open><summary><ChevronDown size={14}/><Folder size={15}/><strong>{t('knowledge.local.files')}</strong><small>{localResources.length}</small></summary><div className={css.treeGroup}>{localResources.map(document=><WikiDocumentRow key={document.id} document={document} selected={selectedResourceId===document.id} onSelect={selectResource}/>)}</div></details>}
      {tree&&<KnowledgeBranch branch={tree} selectedNodeId={selectedNodeId} selectFolder={selectFolder} selectPage={selectPage}/>}
      {count===0&&<div className={css.treeEmpty}><p>{t(query.trim()?'knowledge.manager.searchEmpty':'knowledge.manager.emptyTree')}</p></div>}
    </nav>
  </aside>
}

export function ResourceDraftCard({block,inspect,openResourceDraft}:ToolCallViewProps & {openResourceDraft:(id:string)=>void}){
  const {t}=useI18n()
  const settled='kind' in block
  let draft:ResourceDraft|undefined
  const text=settled?block.content.filter(item=>item.type==='text').map(item=>item.text).join('\n'):''
  if(settled&&!block.isError){try{const value:unknown=JSON.parse(text);if(isResourceDraft(value))draft=value}catch{}}
  return <section className={css.toolCard} aria-label={t('knowledge.manager.title')}><strong>{!settled?t('knowledge.manager.toolRunning'):block.isError?t('knowledge.manager.toolFailed'):t('knowledge.manager.toolReady')}</strong>{draft?<><p>{draft.title}{t('knowledge.manager.toolVersion',{version:draft.version})}</p><p className={css.muted}>{t('knowledge.manager.toolReview')}</p><button className={css.button} onClick={()=>openResourceDraft(draft!.id)}>{t('knowledge.manager.toolOpen')}</button></>:text&&<pre>{text}</pre>}{inspect&&<button className={css.button} onClick={inspect}>{t('knowledge.manager.toolInspect')}</button>}</section>
}
