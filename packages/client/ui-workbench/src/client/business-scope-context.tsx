import { createContext,useContext,type ReactNode } from 'react'
import { businessScopeNames,initialBusinessSpaces,type BusinessScopeLabel } from './business-directory.js'
import {useI18n} from './i18n/provider.js'
const BusinessScopeContext=createContext(businessScopeNames(initialBusinessSpaces()))
export function BusinessScopeProvider({labels,children}:{labels:readonly BusinessScopeLabel[];children:ReactNode}){
 const {t}=useI18n()
 const names=businessScopeNames(labels,{general:t('business.scope.general'),SOC:t('business.scope.soc'),AppSec:t('business.scope.appsec')})
 return <BusinessScopeContext.Provider value={names}>{children}</BusinessScopeContext.Provider>
}
export function useBusinessScopes(){return useContext(BusinessScopeContext)}
