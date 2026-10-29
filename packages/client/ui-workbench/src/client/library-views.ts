import type {KnowledgeTree,ResourceDirectory,ResourceDraft,SourceReference,WorkResource} from '@teloa/contract'
import {isLocalMaterialSourceId} from './local-material-registration.ts'
export type LibraryView='mine'|'recent'|'star'|'local'|'retrieval'|'space'
export type LibraryPreferences={recent:{id:string;at:number}[];favorites:string[]}
export type LibraryRow=((ResourceDraft|WorkResource)&{kind:'draft'|'resource';location:string;knowledgeVersion?:number|undefined;visitedAt?:number|undefined})|{kind:'knowledge';id:string;title:string;sourceId:string;sourceVersion:string;version:number;knowledgeVersion:number;status:'saved';location:string;scopeIds?:readonly string[];visitedAt?:number|undefined}
const empty=():LibraryPreferences=>({recent:[],favorites:[]})
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200
export function libraryPreferenceKey(ownerId:string,spaceId:string){return 'teloa.library/v1/'+encodeURIComponent(ownerId)+'/'+encodeURIComponent(spaceId)}
export function readLibraryPreferences(raw:string|null):LibraryPreferences{
 try{
  const parsed=JSON.parse(raw??'null');if(!parsed||typeof parsed!=='object'||!Array.isArray(parsed.recent)||!Array.isArray(parsed.favorites))return empty()
  const recent=new Map<string,number>()
  for(const row of parsed.recent.slice(0,500)){if(row&&validId(row.id)&&Number.isSafeInteger(row.at)&&row.at>=0&&Number.isFinite(new Date(row.at).getTime()))recent.set(row.id,Math.max(recent.get(row.id)??0,row.at))}
  return {recent:[...recent].map(([id,at])=>({id,at})).sort((a,b)=>b.at-a.at).slice(0,100),favorites:[...new Set<string>(parsed.favorites.filter(validId))].slice(0,100)}
 }catch{return empty()}
}
export function visitLibraryResource(prefs:LibraryPreferences,id:string,at=Date.now()):LibraryPreferences{return {...prefs,recent:[{id,at},...prefs.recent.filter(row=>row.id!==id)].slice(0,100)}}
export function toggleLibraryFavorite(prefs:LibraryPreferences,id:string):LibraryPreferences{return {...prefs,favorites:prefs.favorites.includes(id)?prefs.favorites.filter(value=>value!==id):[id,...prefs.favorites].slice(0,100)}}
export function libraryRows(directory:ResourceDirectory,sources:SourceReference[],options:{view:LibraryView;query:string;preferences:LibraryPreferences;resourceIds?:ReadonlySet<string>;knowledgeIds?:ReadonlySet<string>;tree?:KnowledgeTree|undefined}):LibraryRow[]{
 const {view,preferences,resourceIds}=options,needle=options.query.trim().toLocaleLowerCase(),recent=new Map(preferences.recent.map(row=>[row.id,row.at]))
 const facts=(row:ResourceDraft|WorkResource)=>{
  const source=sources.find(source=>source.id===row.sourceId),knowledgeId=source?.knowledge?.knowledgeId??(row.sourceId.startsWith('knowledge_')?row.sourceId.slice(10):undefined)
  const node=options.tree?.nodes.find(node=>node.type==='page'&&node.knowledgeId===knowledgeId)
  const path=node?.path.slice(0,-1).map(id=>options.tree?.nodes.find(node=>node.id===id)?.title).filter(Boolean).join(' / ')
  const location=path||(source?.knowledge?'':source?.source??'')
  return {location,knowledgeVersion:source?.version===row.sourceVersion?source.knowledge?.knowledgeVersion:undefined,visitedAt:recent.get(row.id)}
 }
 const rows:LibraryRow[]=[...directory.drafts.filter(row=>row.status==='draft').map(row=>({...row,kind:'draft' as const,...facts(row)})),...directory.resources.map(row=>({...row,kind:'resource' as const,...facts(row)}))]
 for(const source of sources){
  const knowledge=source.knowledge,node=options.tree?.nodes.find(node=>node.type==='page'&&node.knowledgeId===knowledge?.knowledgeId)
  if(!knowledge||!node||knowledge.workspaceId!==options.tree?.space.workspaceId||directory.resources.some(row=>sources.find(value=>value.id===row.sourceId)?.knowledge?.knowledgeId===knowledge.knowledgeId||row.sourceId==='knowledge_'+knowledge.knowledgeId))continue
  const location=node.path.slice(0,-1).map(id=>options.tree?.nodes.find(value=>value.id===id)?.title).filter(Boolean).join(' / ')
  rows.push({kind:'knowledge',id:knowledge.knowledgeId,title:node.title,sourceId:source.id,sourceVersion:source.version,version:knowledge.knowledgeVersion,knowledgeVersion:knowledge.knowledgeVersion,status:'saved',location,scopeIds:[...knowledge.scopeIds],visitedAt:recent.get(knowledge.knowledgeId)})
 }
 return rows.filter(row=>(view!=='local'||isLocalMaterialSourceId(row.sourceId))&&(view!=='recent'||recent.has(row.id))&&(view!=='star'||preferences.favorites.includes(row.id))&&(view!=='space'||(row.kind==='knowledge'?options.knowledgeIds?.has(row.id):resourceIds?.has(row.id)))&&(!needle||[row.title,row.location].some(value=>value.toLocaleLowerCase().includes(needle)))).sort((a,b)=>view==='recent'?(b.visitedAt??0)-(a.visitedAt??0):a.title.localeCompare(b.title))
}
