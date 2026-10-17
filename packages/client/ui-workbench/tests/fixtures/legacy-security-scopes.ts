import {builtinBusinessNames,type BusinessScopeLabel} from '../../src/client/business-directory.ts'
import type {TaskPreview} from '../../src/client/task-preview.ts'

/**
 * 这些用例以「已有安全运营 / 应用安全业务的存量目录」为前提（与 backend tests/legacy-security-scopes.ts 同义）。
 * 新目录只预置「通用工作」（6f7346a），这里显式补上存量目录里已有的 SOC/AppSec 标签行；业务范围校验本身不放宽。
 */
export function legacySecurityLabels():BusinessScopeLabel[]{
 return (['general','SOC','AppSec'] as const).map(scope=>({scope,title:builtinBusinessNames[scope],kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}))
}

export function withLegacySecurityScopes<T extends TaskPreview>(state:T):T{
 const legacy=legacySecurityLabels().filter(label=>!state.business.spaces.some(space=>space.scope===label.scope))
 return {...state,business:{...state.business,spaces:[...state.business.spaces,...legacy]}}
}
