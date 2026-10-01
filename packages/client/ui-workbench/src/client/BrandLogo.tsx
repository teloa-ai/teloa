import { useSyncExternalStore } from 'react'
import light from '../brand/teloa-light.svg'
import dark from '../brand/teloa-dark.svg'
import { LOGOTYPE_ASPECT } from '../brand/logotype.js'
export type BrandTheme={subscribe:(notify:()=>void)=>()=>void;getSnapshot:()=> 'light'|'dark'}
export function BrandLogo({theme,height=34}:{theme:BrandTheme;height?:number}){
  const scheme=useSyncExternalStore(theme.subscribe,theme.getSnapshot)
  const width=height*LOGOTYPE_ASPECT
  return <img src={scheme==='dark'?dark:light} alt="Teloa" width={width} height={height} style={{display:'block',maxWidth:'none'}}/>
}
