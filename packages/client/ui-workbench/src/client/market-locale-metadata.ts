import {localizedMetadata,resolveLocalizedMetadata,type LocalizedMetadata,type LocalizedMetadataResolution} from '@teloa/contract'

const traditionalRegions=new Set(['zh-TW','zh-HK'])

/** 地区繁体只走显式地区、人工繁体、英文，避免误回退到简体目录文案。 */
export function resolveMarketLocalizedMetadata(input:LocalizedMetadata,requestedLocale:string):LocalizedMetadataResolution{
 const metadata=localizedMetadata(input)
 const requested=Intl.getCanonicalLocales(requestedLocale.trim())[0]!
 if(!traditionalRegions.has(requested))return resolveLocalizedMetadata(metadata,requested)
 for(const candidate of [requested,'zh-Hant','en']){
  if(!Object.hasOwn(metadata.locales,candidate))continue
  const result=resolveLocalizedMetadata({...metadata,defaultLocale:candidate},candidate)
  if(result.locale!=='zh-CN')return result
 }
 return {value:metadata.original,locale:null}
}
