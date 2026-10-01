import {WorkError} from './work-error.ts'

export type LocalizedMetadataValue=string|{fallback:string}
export type LocalizedMetadata={original:string;defaultLocale:string;locales:Record<string,LocalizedMetadataValue>}
export type LocalizedMetadataResolution={value:string;locale:string|null}

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const record=(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw bad('本地化元数据格式不正确。');return value as Record<string,unknown>}
const exact=(value:unknown,keys:readonly string[])=>{const row=record(value);if(Object.keys(row).some(key=>!keys.includes(key)))throw bad('本地化元数据格式不正确或包含未知字段。');return row}
const locale=(value:unknown):string=>{
 if(typeof value!=='string'||!value.trim()||value.length>80)throw bad('locale 标识不正确。')
 try{const values=Intl.getCanonicalLocales(value.trim());if(values.length!==1)throw Error();return values[0]!}catch{throw bad('locale 标识不正确。')}
}

export function localizedMetadata(input:unknown):LocalizedMetadata{
 const row=exact(input,['original','defaultLocale','locales'])
 if(typeof row.original!=='string'||!row.original.trim()||new TextEncoder().encode(row.original).byteLength>16*1024)throw bad('本地化元数据稳定原文不能为空或超过限制。')
 const defaultLocale=locale(row.defaultLocale),raw=record(row.locales),entries:Record<string,LocalizedMetadataValue>={}
 if(Object.keys(raw).length>100)throw bad('本地化 locale map 不能超过 100 项。')
 for(const [key,inputValue] of Object.entries(raw)){
  const normalized=locale(key);if(Object.hasOwn(entries,normalized))throw bad('本地化 locale map 包含重复的规范 locale。')
  if(typeof inputValue==='string'){if(!inputValue.trim()||new TextEncoder().encode(inputValue).byteLength>16*1024)throw bad('本地化 locale 值不能为空或超过限制。');entries[normalized]=inputValue;continue}
  const alias=exact(inputValue,['fallback']);entries[normalized]={fallback:locale(alias.fallback)}
 }
 const sorted=Object.fromEntries(Object.entries(entries).sort(([a],[b])=>a<b?-1:a>b?1:0))
 for(const start of Object.keys(sorted)){
  const seen=new Set<string>();let current=start
  while(typeof sorted[current]!=='string'){
   if(seen.has(current))throw bad('本地化 fallback 不能形成环。');seen.add(current)
   const value=sorted[current];if(!value||typeof value==='string'||!Object.hasOwn(sorted,value.fallback))throw bad('本地化 fallback 必须指向 locale map 中的已声明项。')
   current=value.fallback
  }
 }
 return {original:row.original,defaultLocale,locales:sorted}
}

export function resolveLocalizedMetadata(input:unknown,requestedLocale:string):LocalizedMetadataResolution{
 const metadata=localizedMetadata(input),requested=locale(requestedLocale),language=requested.split('-')[0]!,candidates=[requested,language,metadata.defaultLocale]
 for(const candidate of new Set(candidates)){
  let current=candidate;const seen=new Set<string>()
  while(Object.hasOwn(metadata.locales,current)){
   if(seen.has(current))throw bad('本地化 fallback 不能形成环。');seen.add(current)
   const value=metadata.locales[current]!
   if(typeof value==='string')return {value,locale:current}
   current=value.fallback
  }
 }
 return {value:metadata.original,locale:null}
}
