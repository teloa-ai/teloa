import type {ReactNode} from 'react'
import {applicationPresentation,type WorkCapability} from '../src/client/application-presentation.ts'
import * as personalProfile from '../src/client/personal-profile.ts'

// 既有手动组件夹具默认运行社区环境；共用真实能力 store，避免各夹具再维护一套权益逻辑。
export const applicationCapabilityModules={
 './application-presentation.js':{applicationPresentation},
 './CapabilityNotice.js':{
  useApplicationCapability:(capability:WorkCapability)=>applicationPresentation.can(capability),
  CapabilityNotice:()=>null,
  CapabilityFields:({children}:{children:ReactNode})=>children,
 },
}
export function applicationCapabilityModule(id:string){
 if(/application-presentation\.(js|ts)$/.test(id))return applicationCapabilityModules['./application-presentation.js']
 if(/personal-profile\.(js|ts)$/.test(id))return personalProfile
 if(id.endsWith('CapabilityNotice.js'))return applicationCapabilityModules['./CapabilityNotice.js']
 return undefined
}
