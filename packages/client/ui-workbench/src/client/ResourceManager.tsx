import {useBusinessScopes} from './business-scope-context.js'
import {DetailsMenu} from './DetailsMenu.js'
import {LibraryList,LibraryViews} from './LibraryList.js'
import {libraryRows,libraryPreferenceKey,readLibraryPreferences,visitLibraryResource,toggleLibraryFavorite,type LibraryPreferences,type LibraryView,type LibraryRow} from './library-views.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {isLocalMaterialSourceId,isAdoptedMaterialSourceId} from './local-material-registration.js'
import {LocalRetrievalResources} from './LocalRetrievalResources.js'
import type {LocalRetrievalApi} from './local-retrieval-api.js'
import { useEffect,useMemo,useRef,useState,type ReactNode } from 'react'
import { ChevronDown,FileCheck,FileText,Folder,FolderInput,FolderPlus,MessageSquare,MoreHorizontal,Pencil,RefreshCw,Search,Plus,Users } from 'lucide-react'
import { encodeResourceReference,type ResourceUsageTarget,type KnowledgeTree,type ResourceDirectory,type ResourceDraft,type RoleArtifactSummary,type SourceReference,type WorkResource } from '@teloa/contract'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { isResourceDraft } from '@teloa/contract'
import type { ResourceApi } from './resource-api.js'
import type {ResourceAdoptionCommand} from './resource-adoption-recovery.js'
import {ResourceKnowledgeDocument} from './ResourceKnowledgeDocument.js'
import {StandaloneKnowledgeDocument} from './StandaloneKnowledgeDocument.js'
import { useDirectoryFocus } from './directory-focus.js'
import { libraryResourceDirectory,buildEmployeeKnowledgeGroups,localizeKnowledgeRoot,buildKnowledgeDirectoryTree,canGovernKnowledgeNode,defaultKnowledgeSelection,defaultResourceSelection,filterResourceManagerDirectory,knowledgeBreadcrumbs,knowledgeMoveTargets,normalizeResourceSourceSelection,resourceSourceFacts,type KnowledgeDirectoryBranch,type KnowledgeDirectoryPage,type ResourceManagerFilters,type EmployeeKnowledgeGroup,filterEmployeeKnowledgeGroups,listedEmployee,type RoleKnowledgeRef} from './resource-manager-presentation.js'
import css from './ResourceManager.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {libraryPreparationRequest,type LibraryPreparationRequest} from './business-library-presentation.js'
export type {LibraryPreparationRequest} from './business-library-presentation.js'

export type ResourceManagerNavigationState={query:string;category:NonNullable<ResourceManagerFilters['category']>;selectedId:string|undefined;mobileLayer:'directory'|'detail';libraryView:LibraryView;browseNodeId:string|undefined}

export function ResourceManager({openUsage,onLocalModels,preferenceStorage,onUseResource,localRetrievalApi,api,roleApi,artifactApi,openArtifact,visible,selectedDraftId,targetResource,clearTarget,openConversation,navigationState,onNavigationChange}:{openUsage?:((target:ResourceUsageTarget,current:()=>boolean)=>void|Promise<void>)|undefined;onLocalModels?:()=>void;preferenceStorage?:WorkbenchNavigationStorage|undefined;onUseResource?:((resource:WorkResource)=>void)|undefined;localRetrievalApi?:LocalRetrievalApi|undefined;api:ResourceApi;roleApi?:{list():Promise<readonly RoleKnowledgeRef[]>}|undefined;artifactApi?:{listByRole(roleId:string):Promise<readonly RoleArtifactSummary[]>}|undefined;openArtifact?:((output:RoleArtifactSummary)=>Promise<void>)|undefined;visible:boolean;selectedDraftId:string|null;targetResource:{id:string;request:number}|null;clearTarget:()=>void;openConversation:(request:LibraryPreparationRequest)=>void;navigationState?:Partial<ResourceManagerNavigationState>;onNavigationChange?:(state:ResourceManagerNavigationState)=>void}){
  const {locale,t}=useI18n(),scopeNames=useBusinessScopes()
  const currentApi=useRef(api);currentApi.current=api
  const [directory,setDirectory]=useState<ResourceDirectory>({drafts:[],resources:[]}),[sources,setSources]=useState<SourceReference[]>([]),[loadedKnowledgeTree,setKnowledgeTree]=useState<KnowledgeTree>()
  // 根节点标题只在显示层本地化；目录操作只用节点身份与修订号，发起会话等请求仍取服务端原始目录。
  const knowledgeRootTitle=t('knowledge.space.rootTitle'),knowledgeTree=useMemo(()=>loadedKnowledgeTree&&localizeKnowledgeRoot(loadedKnowledgeTree,knowledgeRootTitle),[loadedKnowledgeTree,knowledgeRootTitle])
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[batchBusy,setBatchBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>()
  const [employeeGroups,setEmployeeGroups]=useState<EmployeeKnowledgeGroup[]>([]),[knowledgeContextRole,setKnowledgeContextRole]=useState<string>()
  const [browseNodeId,setBrowseNodeId]=useState<string|undefined>(navigationState?.browseNodeId)
  const [libraryView,setLibraryView]=useState<LibraryView>(navigationState?.libraryView??'recent'),[preferences,setPreferences]=useState<LibraryPreferences>({recent:[],favorites:[]}),[loadedApi,setLoadedApi]=useState<ResourceApi>(),[documentDirty,setDocumentDirty]=useState(false),[documentReferenceReady,setDocumentReferenceReady]=useState(false),[pendingLeave,setPendingLeave]=useState<(()=>void)>()
  const prefsKey=useRef<string>(),prefsRef=useRef<LibraryPreferences>({recent:[],favorites:[]})
  const beforeLeave=(action:()=>void)=>{if(documentDirty||tracking&&!!(localTitle.trim()||localPath.trim())||!!editing&&(title!==editing.title||sourceId!==editing.sourceId||sourceVersion!==editing.sourceVersion)){setPendingLeave(()=>action);return}action()}
  const writePreferences=(next:LibraryPreferences)=>{prefsRef.current=next;setPreferences(next);if(prefsKey.current&&preferenceStorage){try{preferenceStorage.setItem(prefsKey.current,JSON.stringify(next))}catch{setNotice(t('library.storage'))}}}
  const recordVisit=(id:string)=>writePreferences(visitLibraryResource(prefsRef.current,id))
  const [query,setQuery]=useState(navigationState?.query??'')
  const [mobileDetailOpen,setMobileDetailOpen]=useState(navigationState?.mobileLayer==='detail')
  const [editing,setEditing]=useState<ResourceDraft>(),[selectedResourceId,setSelectedResourceId]=useState<string|undefined>(navigationState?.selectedId),[title,setTitle]=useState(''),[sourceId,setSourceId]=useState(''),[sourceVersion,setSourceVersion]=useState('')
  const usageMounted=useRef(false),usageLocation=useRef({api,visible,selectedResourceId});usageLocation.current={api,visible,selectedResourceId}
  useEffect(()=>{usageMounted.current=true;return()=>{usageMounted.current=false}},[])
  const [selectedNodeId,setSelectedNodeId]=useState<string|undefined>(navigationState?.selectedId),[creatingFolder,setCreatingFolder]=useState(false),[folderTitle,setFolderTitle]=useState('')
  const [tracking,setTracking]=useState(false),[localTitle,setLocalTitle]=useState(''),[localPath,setLocalPath]=useState(''),localRequests=api.localMaterialRequests
  const [governanceAction,setGovernanceAction]=useState<'rename'|'move'>(),[governanceTitle,setGovernanceTitle]=useState(''),[moveParentId,setMoveParentId]=useState('')
  const knowledgePreparations=useRef(new Map<string,string>())
  const adoptionRecovery=useMemo(()=>loadedApi===api&&loadedKnowledgeTree?api.adoptionRecovery?.({ownerId:loadedKnowledgeTree.space.ownerId,spaceId:loadedKnowledgeTree.space.id}):undefined,[api,loadedApi,loadedKnowledgeTree?.space.ownerId,loadedKnowledgeTree?.space.id])
  type AdoptionForm={resources:WorkResource[];scope:string;requestId?:string;drafts?:ResourceDraft[];applied?:WorkResource[]}
  const [adopting,setAdopting]=useState<AdoptionForm>(),[,setAdoptionRevision]=useState(0),adoptionBusy=useRef(false),adoptionOperation=useRef(0)
  const adoptionForm=(command:ResourceAdoptionCommand):AdoptionForm=>({resources:command.resources,scope:command.input.targetScope,requestId:command.input.requestId,...(command.drafts?{drafts:command.drafts}:{}),applied:command.applied})
  useEffect(()=>{if(adoptionBusy.current){adoptionBusy.current=false;setBusy(false)}setAdopting(undefined);return()=>{adoptionOperation.current++}},[adoptionRecovery])
  const recoverAdoption=()=>beforeLeave(()=>{if(busy||adoptionBusy.current)return;const command=adoptionRecovery?.pending();if(command){setAdopting(adoptionForm(command));setError(undefined);setNotice(undefined)}})
  const startAdoption=(resources:WorkResource[])=>beforeLeave(()=>{if(busy||adoptionBusy.current||!adoptionRecovery)return;const pending=adoptionRecovery.pending();setAdopting(pending?adoptionForm(pending):{resources:resources.filter(row=>row.status==='active'),scope:''});setError(undefined);setNotice(undefined)})
  const prepareAdoption=async()=>{
    if(!adopting||!adopting.scope||!adoptionRecovery||adoptionBusy.current||busy)return
    const flow=adopting,controller=adoptionRecovery,operation=++adoptionOperation.current,current=()=>currentApi.current===api&&adoptionOperation.current===operation
    adoptionBusy.current=true;setBusy(true);setError(undefined);setNotice(undefined)
    try{
      const command=flow.requestId?await controller.recover():await controller.begin(flow.resources,flow.scope)
      if(!current())return
      setAdopting(adoptionForm(command));setNotice(t('roleDelegation.adoptionPrepared',{count:command.drafts?.length??0}));await refresh()
    }catch(cause){if(current()){const pending=controller.pending();setAdopting(pending?adoptionForm(pending):{resources:flow.resources,scope:flow.scope});setError(localizeWorkError(locale,cause))}}finally{if(current()){adoptionBusy.current=false;setBusy(false)}}
  }
  const applyAdoption=async()=>{
    if(!adopting?.drafts||!adoptionRecovery||adoptionBusy.current||busy)return
    const controller=adoptionRecovery,operation=++adoptionOperation.current,current=()=>currentApi.current===api&&adoptionOperation.current===operation
    adoptionBusy.current=true;setBusy(true);setError(undefined)
    try{
      const applied=await controller.apply(command=>{if(current())setAdopting(adoptionForm(command))})
      if(!current())return
      await refresh();if(!current())return
      if(applied[0]){inspectResource(applied[0]);setMobileDetailOpen(true)}
      setNotice(t('roleDelegation.adoptionApplied',{count:applied.length}));setAdopting(undefined)
    }catch(cause){if(current()){const pending=controller.pending();setAdopting(pending?adoptionForm(pending):undefined);setError(localizeWorkError(locale,cause))}}finally{if(current()){adoptionBusy.current=false;setBusy(false)}}
  }
  const requestId=useRef(crypto.randomUUID()),folderRequest=useRef<{requestId:string;parentId:string;title:string;expectedDirectoryRevision:number}>(),governanceRequest=useRef<{requestId:string;operation:'rename'|'move';nodeId:string;value:string;expectedDirectoryRevision:number}>(),loadGeneration=useRef(0),formGeneration=useRef(0),handledDraft=useRef<string|null>(null),restoredSelection=useRef(navigationState?.selectedId)
  const rememberNavigation=(patch:Partial<ResourceManagerNavigationState>)=>currentApi.current===api&&onNavigationChange?.({query,category:'all',libraryView,browseNodeId,selectedId:editing?.id??selectedNodeId??selectedResourceId,mobileLayer:mobileDetailOpen?'detail':'directory',...patch})
  const select=(draft:ResourceDraft)=>{formGeneration.current++;setTracking(false);setEditing(draft);setSelectedResourceId(undefined);setSelectedNodeId(knowledgeTree?.space.rootNodeId);setTitle(draft.title);setSourceId(draft.sourceId);setSourceVersion(draft.sourceVersion);requestId.current=crypto.randomUUID();setError(undefined);setNotice(undefined);rememberNavigation({selectedId:draft.id})}
  const inspectResource=(resource:WorkResource)=>{setKnowledgeContextRole(undefined);formGeneration.current++;setTracking(false);setEditing(undefined);setSelectedResourceId(resource.id);setError(undefined);setNotice(undefined);rememberNavigation({selectedId:resource.id})}
  const pageNodeFor=(resource:WorkResource,tree:KnowledgeTree,available:SourceReference[])=>{
    const knowledgeId=available.find(source=>source.id===resource.sourceId)?.knowledge?.knowledgeId??(resource.sourceId.startsWith('knowledge_')?resource.sourceId.slice('knowledge_'.length):undefined)
    return knowledgeId?tree.nodes.find(node=>node.type==='page'&&node.knowledgeId===knowledgeId):undefined
  }
  const refresh=async()=>{
    if(currentApi.current!==api)return
    const selectionGeneration=formGeneration.current
    const generation=++loadGeneration.current;setLoading(true)
    try{
      const roleRequest=roleApi?roleApi.list().catch(():readonly RoleKnowledgeRef[]=>[] as const):Promise.resolve([] as readonly RoleKnowledgeRef[])
      // 员工成果目录与资料目录并行读取；某位员工读取失败只让其成果段不出现，不阻断资料库。
      const outputRequest=roleRequest.then(async refs=>new Map(artifactApi?await Promise.all(refs.filter(listedEmployee).map(async role=>[role.id,await artifactApi.listByRole(role.id).catch(()=>[] as const)] as const)):[]))
      const [rows,available,tree,roleRefs,outputs]=await Promise.all([api.directory(),api.sources(),api.knowledgeTree(),roleRequest,outputRequest])
      if(generation!==loadGeneration.current||currentApi.current!==api)return
      const nextKey=libraryPreferenceKey(tree.space.ownerId,tree.space.id)
      if(prefsKey.current!==nextKey){prefsKey.current=nextKey;let next:LibraryPreferences={recent:[],favorites:[]};try{next=readLibraryPreferences(preferenceStorage?.getItem(nextKey)??null)}catch{setNotice(t('library.storage'))}prefsRef.current=next;setPreferences(next)}
      const empGroups=buildEmployeeKnowledgeGroups(roleRefs,rows,outputs);setEmployeeGroups(empGroups)
      setLoadedApi(api);setDirectory(rows);setSources(available);setKnowledgeTree(tree)
      if(!tree.nodes.some(node=>node.id===browseNodeId&&node.type!=='page'))setBrowseNodeId(tree.space.rootNodeId)
      const knowledgeRows=libraryResourceDirectory(rows,available)
      if(selectionGeneration===formGeneration.current){
      const restoredId=restoredSelection.current
      restoredSelection.current=undefined
      const restoredDraft=knowledgeRows.drafts.find(row=>row.id===restoredId),restoredResource=rows.resources.find(row=>row.id===restoredId||!editing&&row.id===selectedResourceId&&isLocalMaterialSourceId(row.sourceId)),restoredNode=tree.nodes.find(row=>row.id===restoredId)
      let restoredNextId:string|undefined
      if(restoredDraft){restoredNextId=restoredDraft.id;setEditing(restoredDraft);setSelectedResourceId(undefined);setSelectedNodeId(tree.space.rootNodeId);setTitle(restoredDraft.title);setSourceId(restoredDraft.sourceId);setSourceVersion(restoredDraft.sourceVersion)}
      else if(restoredResource){restoredNextId=restoredResource.id;setEditing(undefined);setSelectedResourceId(restoredResource.id);setSelectedNodeId(pageNodeFor(restoredResource,tree,available)?.id??tree.space.rootNodeId)}
      else{const selection=defaultKnowledgeSelection(tree,knowledgeRows,available,restoredNode?.id??selectedNodeId??(!mobileDetailOpen?tree.space.rootNodeId:undefined));restoredNextId=restoredNode?.id??selection.resourceId??selection.nodeId;setSelectedNodeId(selection.nodeId);if(!editing)setSelectedResourceId(selection.resourceId)}
      if(restoredId&&restoredNextId!==restoredId)rememberNavigation({selectedId:restoredNextId,mobileLayer:restoredNextId?'detail':'directory'})
      if(!restoredDraft){const normalized=normalizeResourceSourceSelection(available,sourceId,sourceVersion);if(normalized.id!==sourceId)setSourceId(normalized.id);if(normalized.version!==sourceVersion)setSourceVersion(normalized.version)}
      if(targetResource){const resource=rows.resources.find(row=>row.id===targetResource.id);if(resource){inspectResource(resource);setSelectedNodeId(pageNodeFor(resource,tree,available)?.id??tree.space.rootNodeId);setMobileDetailOpen(true);rememberNavigation({selectedId:resource.id,mobileLayer:'detail'})}else{setError(t('knowledge.manager.notFound'));clearTarget()}}
      }
    }
    catch(cause){if(generation===loadGeneration.current&&currentApi.current===api)setError(localizeWorkError(locale,cause))}
    finally{if(generation===loadGeneration.current&&currentApi.current===api)setLoading(false)}
  }
    /** 按员工批量加入：只在检索模型就绪时执行；按来源去重，已加入的来源由服务端幂等处理。 */
  const enrollEmployeeMaterials=async(group:EmployeeKnowledgeGroup)=>{
    if(!localRetrievalApi||batchBusy)return
    setBatchBusy(true);setError(undefined);setNotice(undefined)
    try{
      const model=await localRetrievalApi.modelStatus()
      if(!model.enabled||!model.provider||!['ready','standby'].includes(model.provider.preparation.phase)){onLocalModels?.();return}
      const sourceIds=[...new Set(group.resources.filter(resource=>resource.status==='active').map(resource=>resource.sourceId))]
      if(!sourceIds.length){setNotice(t('retrieval.employee.none'));return}
      for(const sourceId of sourceIds)await localRetrievalApi.enroll(sourceId)
      setNotice(t('retrieval.employee.enrolled',{count:sourceIds.length}))
    }catch(cause){setError(localizeWorkError(locale,cause))}finally{setBatchBusy(false)}
  }
const priorApi=useRef(api)
  useEffect(()=>{if(priorApi.current!==api){priorApi.current=api;formGeneration.current++;adoptionOperation.current++;adoptionBusy.current=false;setAdopting(undefined);prefsKey.current=undefined;prefsRef.current={recent:[],favorites:[]};setPreferences(prefsRef.current);setEditing(undefined);setSelectedResourceId(undefined);setSelectedNodeId(undefined);setBrowseNodeId(undefined);setTracking(false);setLocalTitle('');setLocalPath('');setTitle('');setSourceId('');setSourceVersion('');setCreatingFolder(false);setFolderTitle('');setGovernanceAction(undefined);folderRequest.current=undefined;governanceRequest.current=undefined;setMobileDetailOpen(false);setDocumentDirty(false);setPendingLeave(undefined);setBusy(false);setError(undefined);setNotice(undefined);restoredSelection.current=undefined;setQuery('');setLibraryView('recent');setEmployeeGroups([])}if(visible)void refresh();return ()=>{loadGeneration.current++}},[visible,api,targetResource?.request])
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
  const employeeResourceIds=new Set(employeeGroups.flatMap(g=>g.resources.map(r=>r.id)))
  const knowledgeDirectory=libraryResourceDirectory(directory,sources,employeeResourceIds)
  const selectedSource=sources.find(source=>source.id===sourceId)
  const dirty=editing?title!==editing.title||sourceId!==editing.sourceId||sourceVersion!==editing.sourceVersion:true
  const save=async()=>{
    const generation=formGeneration.current;setBusy(true);setError(undefined);setNotice(undefined)
    const fields={title,sourceId,sourceVersion,scopeIds:editing?.scopeIds??['general']}
    try{
      const draft=editing?await api.update({...fields,draftId:editing.id,expectedVersion:editing.version}):await api.create({...fields,requestId:requestId.current})
      if(generation===formGeneration.current&&currentApi.current===api){select(draft);setNotice(t('knowledge.manager.saved'))}
      await refresh()
    }catch(cause){if(generation===formGeneration.current&&currentApi.current===api)setError(localizeWorkError(locale,cause))}finally{if(currentApi.current===api)setBusy(false)}
  }
  const prepareKnowledgeSource=async(source:SourceReference,name:string)=>{
    if(busy||documentDirty)return
    const generation=formGeneration.current;setBusy(true);setError(undefined);setNotice(undefined)
    try{
      const key=JSON.stringify([source.id,source.version,name,source.knowledge?.scopeIds??['general']]),requestId=knowledgePreparations.current.get(key)??crypto.randomUUID()
      knowledgePreparations.current.set(key,requestId)
      const draft=await api.create({requestId,title:name,sourceId:source.id,sourceVersion:source.version,scopeIds:source.knowledge?.scopeIds??['general']})
      knowledgePreparations.current.delete(key)
      if(currentApi.current===api&&formGeneration.current===generation){select(draft);setMobileDetailOpen(true);setNotice(t('roleDelegation.knowledgeDraftReady'))}
      await refresh()
    }catch(cause){if(currentApi.current===api&&formGeneration.current===generation)setError(localizeWorkError(locale,cause))}finally{if(currentApi.current===api)setBusy(false)}
  }
  const trackFile=async(recover=false)=>{
    if(!localRequests||busy)return
    const generation=formGeneration.current;setBusy(true);setError(undefined);setNotice(undefined)
    try{
      const draft=await (recover?localRequests.recover():localRequests.begin({title:localTitle.trim(),path:localPath.trim(),scopeIds:['general']}))
      if(generation===formGeneration.current&&currentApi.current===api){restoredSelection.current=draft.id;select(draft);setMobileDetailOpen(true);rememberNavigation({selectedId:draft.id,mobileLayer:'detail'});setNotice(t('knowledge.local.ready'))}
      await refresh()
    }catch(cause){if(generation===formGeneration.current&&currentApi.current===api)setError(localizeWorkError(locale,cause))}finally{if(currentApi.current===api)setBusy(false)}
  }
  const apply=async()=>{
    if(!editing)return
    const generation=formGeneration.current;setBusy(true);setError(undefined)
    try{const applied=await api.apply(editing);const rows=await api.directory();if(currentApi.current!==api)return;setDirectory(rows);if(generation===formGeneration.current&&currentApi.current===api){inspectResource(applied);setNotice(t('knowledge.manager.applied'))}}
    catch(cause){if(generation===formGeneration.current&&currentApi.current===api)setError(localizeWorkError(locale,cause))}finally{if(currentApi.current===api)setBusy(false)}
  }
  const withdraw=async(resource:WorkResource)=>{
    setBusy(true);setError(undefined)
    try{await api.withdraw(resource);if(currentApi.current!==api)return;setNotice(t('knowledge.manager.withdrawn'));await refresh()}
    catch(cause){if(currentApi.current===api)setError(localizeWorkError(locale,cause))}finally{if(currentApi.current===api)setBusy(false)}
  }
  const copy=async(resource:WorkResource)=>{try{await navigator.clipboard.writeText(encodeResourceReference(resource));if(currentApi.current!==api)return;setNotice(t('knowledge.manager.copied'))}catch{if(currentApi.current===api)setError(t('knowledge.manager.copyFailed'))}}
  const selectedNode=knowledgeTree?.nodes.find(node=>node.id===selectedNodeId),selectedFolder=selectedNode?.type==='folder'||selectedNode?.type==='space'?selectedNode:knowledgeTree?.nodes.find(node=>node.id===selectedNode?.parentId),folderParentId=selectedFolder?.id??knowledgeTree?.space.rootNodeId
  const createFolder=async()=>{
    const value=folderTitle.trim()
    if(!knowledgeTree||!folderParentId||!value)return
    const prior=folderRequest.current,attempt=prior&&prior.parentId===folderParentId&&prior.title===value?prior:{requestId:crypto.randomUUID(),parentId:folderParentId,title:value,expectedDirectoryRevision:knowledgeTree.space.directoryRevision}
    folderRequest.current=attempt;setBusy(true);setError(undefined);setNotice(undefined)
    try{await api.createKnowledgeFolder(attempt);folderRequest.current=undefined;setFolderTitle('');setCreatingFolder(false);setNotice(t('knowledge.manager.folderCreated',{name:selectedFolder?.title??knowledgeTree.space.title}));await refresh()}
    catch(cause){if(currentApi.current===api)setError(localizeWorkError(locale,cause))}finally{if(currentApi.current===api)setBusy(false)}
  }
  const renameNode=async()=>{
    const value=governanceTitle.trim()
    if(!knowledgeTree||!selectedNode||!canGovernKnowledgeNode(knowledgeTree,selectedNode.id)||!value)return
    const prior=governanceRequest.current,attempt=prior&&prior.operation==='rename'&&prior.nodeId===selectedNode.id&&prior.value===value?prior:{requestId:crypto.randomUUID(),operation:'rename' as const,nodeId:selectedNode.id,value,expectedDirectoryRevision:knowledgeTree.space.directoryRevision}
    governanceRequest.current=attempt;setBusy(true);setError(undefined);setNotice(undefined)
    try{await api.renameKnowledgeNode({requestId:attempt.requestId,nodeId:attempt.nodeId,title:attempt.value,expectedDirectoryRevision:attempt.expectedDirectoryRevision});if(currentApi.current!==api)return;governanceRequest.current=undefined;setGovernanceAction(undefined);setNotice(t('knowledge.manager.renamed'));await refresh()}
    catch(cause){if(currentApi.current===api)setError(localizeWorkError(locale,cause))}finally{if(currentApi.current===api)setBusy(false)}
  }
  const moveNode=async()=>{
    if(!knowledgeTree||!selectedNode||!canGovernKnowledgeNode(knowledgeTree,selectedNode.id)||!moveParentId)return
    const prior=governanceRequest.current,attempt=prior&&prior.operation==='move'&&prior.nodeId===selectedNode.id&&prior.value===moveParentId?prior:{requestId:crypto.randomUUID(),operation:'move' as const,nodeId:selectedNode.id,value:moveParentId,expectedDirectoryRevision:knowledgeTree.space.directoryRevision}
    governanceRequest.current=attempt;setBusy(true);setError(undefined);setNotice(undefined)
    try{await api.moveKnowledgeNode({requestId:attempt.requestId,nodeId:attempt.nodeId,parentId:attempt.value,expectedDirectoryRevision:attempt.expectedDirectoryRevision});if(currentApi.current!==api)return;governanceRequest.current=undefined;setGovernanceAction(undefined);setNotice(t('knowledge.manager.moved'));await refresh()}
    catch(cause){if(currentApi.current===api)setError(localizeWorkError(locale,cause))}finally{if(currentApi.current===api)setBusy(false)}
  }
  const visibleDirectory=filterResourceManagerDirectory(knowledgeDirectory,'',sources),visiblePending=filterResourceManagerDirectory(knowledgeDirectory,query,sources).drafts,visibleResources=visibleDirectory.resources,selectedResource=directory.resources.find(resource=>resource.id===selectedResourceId),directoryTree=knowledgeTree?buildKnowledgeDirectoryTree(knowledgeTree,knowledgeDirectory,sources,query):undefined,breadcrumbs=knowledgeTree?knowledgeBreadcrumbs(knowledgeTree,(mobileDetailOpen?selectedNodeId:browseNodeId)??knowledgeTree.space.rootNodeId):[],knowledgeCount=knowledgeDirectory.drafts.length+(knowledgeTree?buildKnowledgeDirectoryTree(knowledgeTree,knowledgeDirectory,sources).count:0)+knowledgeDirectory.resources.filter(row=>isLocalMaterialSourceId(row.sourceId)||isAdoptedMaterialSourceId(row.sourceId)).length,selectedNodePageCount=knowledgeTree&&selectedNode?knowledgeTree.nodes.filter(node=>node.type==='page'&&node.path.includes(selectedNode.id)).length:0
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
  const openRow=(row:LibraryRow)=>beforeLeave(()=>{recordVisit(row.id);if(row.kind==='knowledge'){formGeneration.current++;setEditing(undefined);setSelectedResourceId(undefined);const node=knowledgeTree?.nodes.find(node=>node.type==='page'&&node.knowledgeId===row.id);setSelectedNodeId(node?.id);setMobileDetailOpen(true);setError(undefined);rememberNavigation({selectedId:node?.id,mobileLayer:'detail'});return}if(row.kind==='draft')select(row as ResourceDraft);else{inspectResource(row as WorkResource);setSelectedNodeId(knowledgeTree?pageNodeFor(row as WorkResource,knowledgeTree,sources)?.id??knowledgeTree.space.rootNodeId:undefined)}setMobileDetailOpen(true);rememberNavigation({selectedId:row.id,mobileLayer:'detail'})})
  const openSpacePage=(page:KnowledgeDirectoryPage)=>beforeLeave(()=>{
    const node=knowledgeTree?.nodes.find(node=>node.type==='page'&&node.id===page.id)
    if(!node)return
    const resource=page.resourceId?directory.resources.find(resource=>resource.id===page.resourceId):undefined,parentId=node.parentId??knowledgeTree?.space.rootNodeId
    recordVisit(resource?.id??page.knowledgeId);formGeneration.current++;setKnowledgeContextRole(undefined);setTracking(false);setEditing(undefined);setLibraryView('space');setBrowseNodeId(parentId);setSelectedNodeId(node.id);setSelectedResourceId(resource?.id);setMobileDetailOpen(true);setError(undefined);setNotice(undefined);rememberNavigation({libraryView:'space',browseNodeId:parentId,selectedId:resource?.id??node.id,mobileLayer:'detail'})
  })
  const changeLibraryView=(view:LibraryView)=>beforeLeave(()=>{formGeneration.current++;setLibraryView(view);setEditing(undefined);setTracking(false);setMobileDetailOpen(false);setSelectedResourceId(undefined);setSelectedNodeId(knowledgeTree?.space.rootNodeId);setDocumentDirty(false);rememberNavigation({libraryView:view,selectedId:undefined,mobileLayer:'directory'})})
  useEffect(()=>{if(navigationState?.libraryView==='retrieval'&&(libraryView!=='retrieval'||navigationState.mobileLayer==='directory'&&mobileDetailOpen))changeLibraryView('retrieval')},[navigationState?.libraryView,navigationState?.mobileLayer,navigationState?.selectedId])
  const spaceResourceIds=new Set(knowledgeTree?.nodes.filter(node=>node.type==='page'&&node.path.includes(browseNodeId??knowledgeTree.space.rootNodeId)).flatMap(node=>node.type==='page'?directory.resources.filter(resource=>pageNodeFor(resource,knowledgeTree,sources)?.id===node.id).map(resource=>resource.id):[]))
  const spaceKnowledgeIds=new Set(knowledgeTree?.nodes.flatMap(node=>node.type==='page'&&node.path.includes(browseNodeId??knowledgeTree.space.rootNodeId)?[node.knowledgeId]:[]))
  const rows=libraryRows(knowledgeDirectory,sources,{view:libraryView,query,preferences,resourceIds:spaceResourceIds,knowledgeIds:spaceKnowledgeIds,tree:knowledgeTree})
  const standaloneSource=selectedNode?.type==='page'&&!selectedResource?sources.find(source=>source.knowledge?.knowledgeId===selectedNode.knowledgeId):undefined
  const prepareMaterials=()=>beforeLeave(()=>openConversation(libraryPreparationRequest(loadedKnowledgeTree,libraryView==='space'?browseNodeId:folderParentId,locale)))
  const startLocalRegistration=()=>beforeLeave(()=>{formGeneration.current++;setTracking(true);setEditing(undefined);setSelectedResourceId(undefined);setSelectedNodeId(folderParentId);setMobileDetailOpen(true);setError(undefined)})
  const renderedFormGeneration=formGeneration.current
  const directoryFocus=useDirectoryFocus(visible,mobileDetailOpen?(editing?.id??selectedNodeId??selectedResourceId):undefined,!tracking)
  /** 1.0（设计 09）：搜索与「添加资料」放在目录列顶部，页面标题只给读屏；快捷视图列在目录列里。 */
  const libraryToolbar=<div className={css.libraryToolbar}><label className={css.librarySearch}><Search size={16}/><input type="search" aria-label={t('library.search')} placeholder={t('library.search')} value={query} onChange={event=>{setQuery(event.target.value);rememberNavigation({query:event.target.value})}}/></label><DetailsMenu className={css.addMenu} resetKey={`${visible}:${libraryView}`} closeOnSelect><summary aria-label={t('library.add')} title={t('library.add')}><Plus size={16}/></summary><div><button type="button" onClick={prepareMaterials}><MessageSquare size={15}/>{t('knowledge.manager.openConversation')}</button>{localRequests&&<button type="button" onClick={startLocalRegistration}><FileText size={15}/>{t('knowledge.local.track')}</button>}</div></DetailsMenu></div>
  return <section className={css.page} data-mobile-detail={mobileDetailOpen?'open':'directory'} hidden={!visible} aria-label={t('knowledge.manager.title')}>
    <h1 className={css.srOnly}>{t('library.title')}</h1>
    {error&&<p className={css.message} role="alert">{error}</p>}{notice&&<p className={css.message} role="status">{notice}</p>}
    {adoptionRecovery?.recoveryMessage()&&<div className={css.adoption} role="alert"><p>{localizeWorkError(locale,adoptionRecovery.recoveryMessage())}</p><button type="button" className={css.button} disabled={busy} onClick={()=>{try{adoptionRecovery.clearCorrupt();setAdoptionRevision(value=>value+1)}catch(cause){setError(localizeWorkError(locale,cause))}}}>{t('roleDelegation.adoptionClearCorrupt')}</button></div>}
    {!adopting&&adoptionRecovery?.pending()&&<div className={css.adoption}><p>{t('roleDelegation.adoptionPending')}</p><button type="button" className={css.button} disabled={busy} onClick={recoverAdoption}>{t('roleDelegation.adoptionRecover')}</button></div>}
    {adopting&&<ResourceAdoptionForm resources={adopting.resources} scope={adopting.scope} locked={!!adopting.requestId} drafts={adopting.drafts} applied={adopting.applied?.length??0} scopeNames={scopeNames} busy={busy} change={scope=>setAdopting({...adopting,scope})} prepare={()=>void prepareAdoption()} apply={()=>void applyAdoption()} cancel={()=>setAdopting(undefined)}/>}
    {pendingLeave&&<div className={css.unsaved} role="alert"><p>{t('library.unsaved')}</p><button className={css.button} onClick={()=>setPendingLeave(undefined)}>{t('library.stay')}</button><button className={css.button} onClick={()=>{const action=pendingLeave;setPendingLeave(undefined);setDocumentDirty(false);action()}}>{t('library.leave')}</button></div>}
    <div {...directoryFocus} className={css.workspace}>
      {/* 工具行与快捷视图不等目录读完：目录晚到不能关闭用户刚打开的添加菜单。 */}
      <div className={css.directoryColumn}>{libraryToolbar}<LibraryViews view={libraryView} onChange={changeLibraryView} retrieval={!!localRetrievalApi}/>{loadedApi===api&&<WikiKnowledgeTree
        tree={directoryTree}
        query={query}
        selectedNodeId={libraryView==='space'||mobileDetailOpen?selectedNodeId:undefined}
        selectFolder={id=>beforeLeave(()=>{formGeneration.current++;setLibraryView('space');setBrowseNodeId(id);setSelectedNodeId(id);setEditing(undefined);setSelectedResourceId(undefined);setMobileDetailOpen(false);rememberNavigation({libraryView:'space',browseNodeId:id,selectedId:id,mobileLayer:'directory'})})}
        selectPage={openSpacePage}
        openConversation={prepareMaterials}
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
        employeeGroups={employeeGroups}
        batchBusy={batchBusy||busy}
        {...(adoptionRecovery?{onAdoptEmployee:(group:EmployeeKnowledgeGroup)=>startAdoption(group.resources)}:{})}
        {...(localRetrievalApi?{onEnrollEmployee:enrollEmployeeMaterials}:{})}
        selectedResourceId={selectedResourceId}
        {...(openArtifact?{openArtifact:(output:RoleArtifactSummary)=>{setError(undefined);void openArtifact(output).catch(cause=>{if(currentApi.current===api)setError(localizeWorkError(locale,cause))})}}:{})}
        selectResource={(resource,roleId)=>beforeLeave(()=>{setKnowledgeContextRole(roleId);recordVisit(resource.id);formGeneration.current++;setEditing(undefined);setSelectedResourceId(resource.id);setSelectedNodeId(knowledgeTree?.space.rootNodeId);setMobileDetailOpen(true);setError(undefined);rememberNavigation({selectedId:resource.id,mobileLayer:'detail'})})}
      />
}</div>
      {loadedApi===api?<main data-teloa-pane="detail" tabIndex={-1} className={css.detail} aria-label={t('knowledge.manager.detailAria')}>{(mobileDetailOpen||editing||tracking)&&<div className={css.documentToolbar}><button type="button" className={css.button} onClick={()=>beforeLeave(()=>{formGeneration.current++;setMobileDetailOpen(false);setEditing(undefined);setTracking(false);rememberNavigation({selectedId:browseNodeId,mobileLayer:'directory'})})}>{t('library.back')}</button>{selectedResource?.status==='withdrawn'&&sources.some(source=>source.id===selectedResource.sourceId)&&<button type="button" className={css.button} disabled={busy||documentDirty} onClick={()=>{const source=sources.find(source=>source.id===selectedResource.sourceId);if(source)void prepareKnowledgeSource(source,selectedResource.title)}}>{t('roleDelegation.prepareKnowledgeAgain')}</button>}{selectedResource?.status==='active'&&localRetrievalApi&&libraryView!=='retrieval'&&!editing&&!tracking&&<button type="button" className={css.button} disabled={busy||documentDirty} onClick={()=>beforeLeave(()=>{setLibraryView('retrieval');rememberNavigation({libraryView:'retrieval',mobileLayer:'detail'})})}>{t('library.retrieval')}</button>}{selectedResource?.status==='active'&&adoptionRecovery&&!editing&&!tracking&&<button type="button" className={css.button} disabled={busy||documentDirty} onClick={()=>startAdoption([selectedResource])}>{t('roleDelegation.adoptOtherBusiness')}</button>}{selectedResource?.status==='active'&&onUseResource&&!editing&&!tracking&&<button type="button" className={css.primaryButton} disabled={!documentReferenceReady||documentDirty||busy} title={documentDirty?t('library.unsaved'):undefined} onClick={()=>onUseResource(selectedResource)}>{t('library.use')}</button>}</div>}{breadcrumbs.length>0&&(libraryView==='space'||mobileDetailOpen)&&<nav className={css.breadcrumbs} aria-label={t('knowledge.manager.breadcrumbAria')}>{breadcrumbs.map((item,index)=><span key={item.id}>{index>0&&<i>/</i>}<button type="button" aria-current={item.id===selectedNodeId?'page':undefined} onClick={()=>beforeLeave(()=>{if(item.type!=='page'){formGeneration.current++;setLibraryView('space');setBrowseNodeId(item.id);setSelectedNodeId(item.id);setEditing(undefined);setSelectedResourceId(undefined);setMobileDetailOpen(false);rememberNavigation({libraryView:'space',browseNodeId:item.id,selectedId:item.id,mobileLayer:'directory'})}})}>{item.title}</button></span>)}</nav>}{libraryView==='retrieval'&&localRetrievalApi?<><h2 className={css.listTitle}>{t('library.retrieval')}</h2><LocalRetrievalResources api={localRetrievalApi} resource={mobileDetailOpen?selectedResource:undefined} visible={visible} {...(onLocalModels?{onModelSettings:onLocalModels}:{})}/></>:!mobileDetailOpen&&!editing&&!tracking?<><h2 className={css.listTitle}>{libraryView==='space'?knowledgeTree?.nodes.find(node=>node.id===browseNodeId)?.title??knowledgeTree?.space.title:t(`library.${libraryView}`)}</h2><LibraryList rows={rows} view={libraryView} query={query} preferences={preferences} loading={loading} browseAll={()=>changeLibraryView('mine')} add={prepareMaterials} open={openRow} favorite={id=>writePreferences(toggleLibraryFavorite(prefsRef.current,id))} clear={()=>{setQuery('');rememberNavigation({query:''})}}/></>:tracking&&localRequests?<form className={css.editor} onSubmit={event=>{event.preventDefault();void trackFile()}}><h2>{t('knowledge.local.track')}</h2><p className={css.muted}>{t('knowledge.local.boundary')}</p><fieldset disabled={busy||!!localRequests.pending()||!!localRequests.recoveryMessage()}><label>{t('knowledge.manager.name')}<input autoFocus required maxLength={200} value={localTitle} onChange={event=>setLocalTitle(event.target.value)}/></label><label>{t('knowledge.local.path')}<input required maxLength={4096} value={localPath} onChange={event=>setLocalPath(event.target.value)}/></label><div className={css.actions}><button type="button" className={css.button} onClick={()=>setTracking(false)}>{t('knowledge.manager.cancel')}</button><button type="submit" className={css.primaryButton} disabled={!localTitle.trim()||!localPath.trim()}>{t('knowledge.local.save')}</button></div></fieldset>{localRequests.recoveryMessage()&&<div role="alert"><p>{localizeWorkError(locale,localRequests.recoveryMessage())}</p><p>{t('recovery.nextStep')}</p></div>}{localRequests.pending()&&<div className={css.actions}><p>{t('knowledge.local.unknown')}</p><button type="button" className={css.button} disabled={busy} onClick={()=>void trackFile(true)}>{t('knowledge.local.recover')}</button></div>}{localRequests.recoveryMessage()&&<button type="button" className={css.button} disabled={busy} onClick={()=>{localRequests.discard();setError(undefined);setNotice(t('recovery.discarded'))}}>{t('recovery.discard')}</button>}</form>:editing?<form className={css.editor} onSubmit={event=>{event.preventDefault();void save()}}><h2>{t('knowledge.manager.editTitle')}</h2><fieldset disabled={busy||editing.status==='applied'}><label>{t('knowledge.manager.name')}<input value={title} maxLength={200} required onChange={event=>setTitle(event.target.value)}/></label><label>{t('knowledge.manager.source')}<select value={sourceId} required onChange={event=>{setSourceId(event.target.value);setSourceVersion(sources.find(source=>source.id===event.target.value)?.version??'')}}><option value="">{t('knowledge.manager.selectSource')}</option>{sources.map(source=><option key={source.id} value={source.id}>{source.title}</option>)}</select></label><label>{t('knowledge.manager.scope')}<input value={(editing.scopeIds??['general']).map(scope=>scopeNames[scope]??scope).join(', ')} readOnly/></label><label>{t('knowledge.manager.currentVersion')}<output className={css.version}>{sourceVersion||t('knowledge.manager.noVersion')}</output></label>{selectedSource&&sourceVersion!==selectedSource.version&&<button type="button" className={css.button} onClick={()=>setSourceVersion(selectedSource.version)}>{t('knowledge.manager.useLatest')}</button>}<div className={css.actions}><button type="submit" className={css.button} disabled={!title.trim()||!sourceId||!sourceVersion||!dirty}>{t('knowledge.manager.save')}</button><button type="button" className={css.primaryButton} disabled={dirty} onClick={()=>void apply()}>{t('knowledge.manager.apply')}</button></div></fieldset><details className={css.moreFacts}><summary>{t('knowledge.manager.sourceFacts')}</summary><dl className={css.governanceFacts}>{resourceSourceFacts(selectedSource).map(([term,value])=><div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}</dl></details>{editing.status==='applied'?<p className={css.muted}>{t('knowledge.manager.appliedNote')}</p>:dirty&&<p className={css.muted}>{t('knowledge.manager.unsavedNote')}</p>}</form>:selectedResource?<><p className={css.muted}>{isLocalMaterialSourceId(selectedResource.sourceId)||isAdoptedMaterialSourceId(selectedResource.sourceId)?sources.find(source=>source.id===selectedResource.sourceId)?.source:null}</p><ResourceKnowledgeDocument employees={employeeGroups.filter(group=>group.resources.some(row=>row.id===selectedResource.id)).map(group=>({id:group.roleId,name:group.roleName}))} contextRoleId={knowledgeContextRole} beforeLeave={beforeLeave} openUsage={openUsage? target=>{const id=selectedResource.id,current=()=>usageMounted.current&&usageLocation.current.api===api&&usageLocation.current.visible&&usageLocation.current.selectedResourceId===id;beforeLeave(()=>{if(!current())return;void Promise.resolve().then(()=>{if(current())return openUsage(target,current)}).catch(cause=>{if(current())setError(localizeWorkError(locale,cause))})})}:undefined} key={selectedResource.id+':'+(knowledgeContextRole??'global')} onDirtyChange={setDocumentDirty} onReferenceReadyChange={setDocumentReferenceReady} api={api} resource={selectedResource} source={sources.find(source=>source.id===selectedResource.sourceId)} onPublished={async resourceId=>{if(currentApi.current!==api||formGeneration.current!==renderedFormGeneration)return;await refresh();if(currentApi.current===api&&formGeneration.current===renderedFormGeneration)setSelectedResourceId(resourceId)}} onCopy={()=>void copy(selectedResource)} onWithdraw={()=>void withdraw(selectedResource)} onNotice={setNotice} onError={setError}/></>:standaloneSource&&knowledgeTree?<StandaloneKnowledgeDocument key={knowledgeTree.space.ownerId+':'+standaloneSource.knowledge!.knowledgeId} api={api} ownerId={knowledgeTree.space.ownerId} source={standaloneSource} title={selectedNode?.title??standaloneSource.title} storage={preferenceStorage} onPrepare={()=>void prepareKnowledgeSource(standaloneSource,selectedNode?.title??standaloneSource.title)} onPublished={async()=>{if(currentApi.current===api&&formGeneration.current===renderedFormGeneration)await refresh()}} onError={setError} onNotice={setNotice}/>:selectedNode?.type==='page'?<section className={css.folderDetail}><FileText size={28}/><h2>{selectedNode.title}</h2><p>{t('knowledge.manager.bodyUnavailable')}</p></section>:selectedNode&&(selectedNode.type==='folder'||selectedNode.type==='space')?<section className={css.folderDetail}><Folder size={28}/><h2>{selectedNode.title}</h2><p>{selectedNode.type==='space'?t('knowledge.manager.spaceDescription'):t('knowledge.manager.folderPages',{count:selectedNodePageCount})}</p><button type="button" className={css.button} onClick={()=>setCreatingFolder(true)}><FolderPlus size={15}/>{t('knowledge.manager.newFolder')}</button></section>:<section className={css.emptyDetail}><h2>{t(knowledgeCount===0?'knowledge.manager.emptyTitle':'knowledge.manager.selectTitle')}</h2><p>{t(knowledgeCount===0?'knowledge.manager.emptyDescription':'knowledge.manager.selectDescription')}</p>{knowledgeCount===0&&<button type="button" className={css.primaryButton} onClick={prepareMaterials}>{t('knowledge.manager.openConversation')}</button>}</section>}</main>:<section className={css.emptyDetail} aria-busy={loading}>{error?null:t('knowledge.refresh')}</section>}
    </div>
  </section>
}

function ResourceAdoptionForm({resources,scope,locked,drafts,applied,scopeNames,busy,change,prepare,apply,cancel}:{resources:WorkResource[];scope:string;locked:boolean;drafts:ResourceDraft[]|undefined;applied:number;scopeNames:Record<string,string>;busy:boolean;change:(scope:string)=>void;prepare:()=>void;apply:()=>void;cancel:()=>void}){
 const {t}=useI18n(),choices=Object.entries(scopeNames).filter(([key])=>key!=='general'&&!resources.every(row=>row.scopeIds.length===1&&row.scopeIds[0]===key))
 return <section className={css.adoption} aria-label={t('roleDelegation.adoptOtherBusiness')}><form className={css.editor} onSubmit={event=>{event.preventDefault();drafts?apply():prepare()}}><h2>{t('roleDelegation.adoptOtherBusiness')}</h2><p className={css.muted}>{t('roleDelegation.adoptionBoundary')}</p><details><summary>{t('roleDelegation.adoptionMaterials',{count:resources.length})}</summary><ul>{resources.map(row=><li key={row.id}>{row.title} · {row.scopeIds.map(key=>scopeNames[key]??key).join('、')} · v{row.version}</li>)}</ul></details><label>{t('roleDelegation.adoptionTarget')}<select aria-label={t('roleDelegation.adoptionTarget')} autoFocus required value={scope} disabled={busy||locked||!!drafts} onChange={event=>change(event.target.value)}><option value="">{t('roleDelegation.adoptionChoose')}</option>{choices.map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label>{!choices.length&&<p role="status">{t('roleDelegation.adoptionNoTarget')}</p>}{drafts&&<p role="status">{t('roleDelegation.adoptionReview',{count:drafts.length,applied})}</p>}<div className={css.actions}><button type="button" className={css.button} disabled={busy} onClick={cancel}>{t(locked?'roleDelegation.adoptionClose':'knowledge.manager.cancel')}</button><button type="submit" className={css.primaryButton} disabled={busy||!resources.length||!choices.some(([key])=>key===scope)}>{busy?t('knowledge.refresh'):t(drafts?'roleDelegation.adoptionApply':locked?'roleDelegation.adoptionRecoverPrepare':'roleDelegation.adoptionPrepare')}</button></div></form></section>
}

function KnowledgeGovernance({nodeTitle,action,title,moveParentId,moveTargets,busy,startRename,startMove,changeTitle,changeMoveParent,cancel,rename,move}:{nodeTitle:string;action:'rename'|'move'|undefined;title:string;moveParentId:string;moveTargets:{id:string;label:string}[];busy:boolean;startRename:()=>void;startMove:()=>void;changeTitle:(value:string)=>void;changeMoveParent:(value:string)=>void;cancel:()=>void;rename:()=>void;move:()=>void}){
  const {t}=useI18n()
  return <section className={css.governance} aria-label={t('knowledge.manager.manageAria',{name:nodeTitle})}>{!action&&<DetailsMenu className={css.governanceMenu} resetKey={nodeTitle} closeOnSelect><summary aria-label={t('knowledge.manager.manageAria',{name:nodeTitle})}><MoreHorizontal size={18}/></summary><div><button type="button" onClick={startRename}><Pencil size={14}/>{t('knowledge.manager.rename')}</button><button type="button" disabled={!moveTargets.length} onClick={startMove}><FolderInput size={14}/>{t('knowledge.manager.move')}</button></div></DetailsMenu>}{action==='rename'&&<form onSubmit={event=>{event.preventDefault();rename()}}><label>{t('knowledge.manager.name')}<input autoFocus value={title} maxLength={200} required onChange={event=>changeTitle(event.target.value)}/></label><div><button type="button" onClick={cancel}>{t('knowledge.manager.cancel')}</button><button type="submit" disabled={busy||!title.trim()||title.trim()===nodeTitle}>{t('knowledge.manager.rename')}</button></div></form>}{action==='move'&&<form onSubmit={event=>{event.preventDefault();move()}}><label>{t('knowledge.manager.move')}<select autoFocus value={moveParentId} required onChange={event=>changeMoveParent(event.target.value)}>{moveTargets.map(target=><option key={target.id} value={target.id}>{target.label}</option>)}</select></label><div><button type="button" onClick={cancel}>{t('knowledge.manager.cancel')}</button><button type="submit" disabled={busy||!moveParentId}>{t('knowledge.manager.move')}</button></div></form>}</section>
}

function KnowledgeBranch({branch,selectedNodeId,selectFolder,selectPage}:{branch:KnowledgeDirectoryBranch;selectedNodeId:string|undefined;selectFolder:(id:string)=>void;selectPage:(page:KnowledgeDirectoryPage)=>void}){
  return <details className={css.treeBranch} open><summary data-teloa-entry={branch.id} aria-current={selectedNodeId===branch.id?'page':undefined} onClick={()=>selectFolder(branch.id)}><ChevronDown size={14}/><Folder size={15}/><strong>{branch.title}</strong><small>{branch.count}</small></summary><div className={css.treeGroup}>{branch.children.map(child=>child.type==='page'?<button key={child.id} type="button" data-teloa-entry={child.id} className={css.treeDocument} aria-current={selectedNodeId===child.id?'page':undefined} onClick={()=>selectPage(child)}><FileText size={14}/><span><strong>{child.title}</strong></span></button>:<KnowledgeBranch key={child.id} branch={child} selectedNodeId={selectedNodeId} selectFolder={selectFolder} selectPage={selectPage}/>)}</div></details>
}

function WikiKnowledgeTree({tree,query,selectedNodeId,selectFolder,selectPage,openConversation,refresh,refreshing,creatingFolder,folderTitle,folderTarget,startFolder,cancelFolder,setFolderTitle,createFolder,governance,employeeGroups,batchBusy=false,onEnrollEmployee,onAdoptEmployee,selectedResourceId,selectResource,openArtifact}:{
  query:string
  tree:KnowledgeDirectoryBranch|undefined;selectedNodeId:string|undefined
  selectFolder:(id:string)=>void;selectPage:(page:KnowledgeDirectoryPage)=>void;openConversation:()=>void
  refresh:()=>void;refreshing:boolean;creatingFolder:boolean;folderTitle:string;folderTarget:string
  startFolder:()=>void;cancelFolder:()=>void;setFolderTitle:(value:string)=>void;createFolder:()=>void
  governance:ReactNode
  employeeGroups:EmployeeKnowledgeGroup[];batchBusy?:boolean;onAdoptEmployee?:(group:EmployeeKnowledgeGroup)=>void;onEnrollEmployee?:(group:EmployeeKnowledgeGroup)=>void;selectedResourceId:string|undefined;selectResource:(resource:WorkResource,roleId?:string)=>void;openArtifact?:(output:RoleArtifactSummary)=>void
}){
  const {t}=useI18n()
  const count=tree?.count??0
  return <aside data-teloa-pane="directory" tabIndex={-1} className={css.taxonomy} aria-label={t('knowledge.directory')}>
    <header className={css.treeHeader}><h2>{t('library.space')}</h2><div><button type="button" title={t('knowledge.manager.newFolder')} aria-label={t('knowledge.manager.newFolder')} disabled={!tree||refreshing} onClick={startFolder}><FolderPlus size={16}/></button><button type="button" title={t('knowledge.manager.openConversation')} aria-label={t('knowledge.manager.openConversation')} onClick={openConversation}><MessageSquare size={16}/></button><button type="button" title={t('knowledge.refresh')} aria-label={t('knowledge.refresh')} disabled={refreshing} onClick={refresh}><RefreshCw size={16}/></button>{governance}</div></header>

    {creatingFolder&&<form className={css.folderForm} onSubmit={event=>{event.preventDefault();createFolder()}}><span>{t('knowledge.manager.folderTarget',{name:folderTarget})}</span><input autoFocus value={folderTitle} maxLength={200} required placeholder={t('knowledge.manager.folderName')} onChange={event=>setFolderTitle(event.target.value)}/><div><button type="button" onClick={cancelFolder}>{t('knowledge.manager.cancel')}</button><button type="submit" disabled={refreshing||!folderTitle.trim()}>{t('knowledge.manager.newFolder')}</button></div></form>}
    <nav className={css.wikiTree} aria-label={t('knowledge.directory')}>
      {tree&&<KnowledgeBranch branch={tree} selectedNodeId={selectedNodeId} selectFolder={selectFolder} selectPage={selectPage}/>}
      {count===0&&<div className={css.treeEmpty}><p>{t(query.trim()?'knowledge.manager.searchEmpty':'knowledge.manager.emptyTree')}</p></div>}
      {filterEmployeeKnowledgeGroups(employeeGroups,query).map(group=><details key={group.roleId} className={css.treeBranch} open><summary data-teloa-entry={group.roleId}><ChevronDown size={14}/><Users size={15}/><strong>{group.roleName}</strong><small>{group.resources.length+group.outputs.length}</small></summary><div className={css.treeGroup}>
        {group.resources.some(row=>row.status==='active')&&onAdoptEmployee&&<button type="button" className={css.treeBatch} disabled={batchBusy} onClick={()=>onAdoptEmployee(group)}>{t('roleDelegation.adoptEmployeeBusiness',{count:group.resources.filter(row=>row.status==='active').length})}</button>}
        {group.resources.length>0&&onEnrollEmployee&&<button type="button" className={css.treeBatch} disabled={batchBusy} onClick={()=>void onEnrollEmployee(group)}>{t('retrieval.employee.enrollAll',{count:group.resources.length})}</button>}
        {group.resources.length>0&&<details className={css.treeBranch} open><summary><ChevronDown size={14}/><Folder size={15}/><strong>{t('library.employeeMaterials')}</strong><small>{group.resources.length}</small></summary><div className={css.treeGroup}>{group.resources.map(resource=><button key={resource.id} type="button" className={css.treeDocument} aria-current={selectedResourceId===resource.id?'page':undefined} onClick={()=>selectResource(resource,group.roleId)}><FileText size={14}/><span><strong>{resource.title}</strong></span></button>)}</div></details>}
        {group.outputs.length>0&&<details className={css.treeBranch} open><summary><ChevronDown size={14}/><Folder size={15}/><strong>{t('library.employeeOutputs')}</strong><small>{group.outputs.length}</small></summary><div className={css.treeGroup}>{group.outputs.map(output=><button key={output.artifactId} type="button" className={css.treeDocument} title={output.source.title} disabled={!openArtifact} onClick={()=>openArtifact?.(output)}><FileCheck size={14}/><span><strong>{output.title}</strong></span></button>)}</div></details>}
      </div></details>)}
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
