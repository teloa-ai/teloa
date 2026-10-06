import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

export function readWorkbenchNavigationStorageScope(value:unknown):string{
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('应用导航恢复范围不可用。')
  return value
}

/** 原生宿主范围跨窗口恢复；普通标签页继续使用自己的 sessionStorage。 */
export function createWorkbenchNavigationStorage(scope:string|undefined,sources:{sessionStorage:WorkbenchNavigationStorage;localStorage:WorkbenchNavigationStorage}):WorkbenchNavigationStorage{
  if(scope===undefined)return sources.sessionStorage
  const prefix='teloa.native-navigation/v1/'+readWorkbenchNavigationStorageScope(scope)+'/'
  const storage=sources.localStorage
  return {
    getItem:key=>storage.getItem(prefix+key),
    setItem:(key,value)=>storage.setItem(prefix+key,value),
    removeItem:key=>storage.removeItem(prefix+key),
  }
}
