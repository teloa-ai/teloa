import type {ResourceDirectory,ResourceDraft,SourceReference,WorkResource} from '@teloa/contract'
import {isLocalMaterialSourceId} from './local-material-registration.ts'
export type LibraryView='mine'|'recent'|'star'|'local'|'space'
export type LibraryPreferences={recent:{id:string;at:number}[];favorites:string[]}
export type LibraryRow=(ResourceDraft|WorkResource)&{kind:'draft'|'resource';location:string;visitedAt?:number|undefined}
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
export function libraryRows(directory:ResourceDirectory,sources:SourceReference[],options:{view:LibraryView;query:string;preferences:LibraryPreferences;resourceIds?:ReadonlySet<string>}):LibraryRow[]{
 const {view,preferences,resourceIds}=options,needle=options.query.trim().toLocaleLowerCase(),recent=new Map(preferences.recent.map(row=>[row.id,row.at]))
 const rows:LibraryRow[]=[...directory.drafts.filter(row=>row.status==='draft').map(row=>({...row,kind:'draft' as const,location:sources.find(source=>source.id===row.sourceId)?.source??'',visitedAt:recent.get(row.id)})),...directory.resources.map(row=>({...row,kind:'resource' as const,location:sources.find(source=>source.id===row.sourceId)?.source??'',visitedAt:recent.get(row.id)}))]
 return rows.filter(row=>(view!=='local'||isLocalMaterialSourceId(row.sourceId))&&(view!=='recent'||recent.has(row.id))&&(view!=='star'||preferences.favorites.includes(row.id))&&(view!=='space'||resourceIds?.has(row.id))&&(!needle||[row.title,row.location].some(value=>value.toLocaleLowerCase().includes(needle)))).sort((a,b)=>view==='recent'?(b.visitedAt??0)-(a.visitedAt??0):a.title.localeCompare(b.title))
}
