import type {DshLocalePort} from './index.js'

/**
 * Teloa 给 DSH 自带组件补外部语言的公共层。
 *
 * 两份词表（设置外壳 `dsh-settings.ts`、右栏与三个内容插件 `dsh-sidebar.ts`）此前把
 * 语言清单、`Row`、`dictionary` 与安装循环逐字重复了一遍。词表内容各归各家，
 * 取列与安装的规矩只该有一处。
 *
 * 九列：`[key, zh-Hant, ja, ko, vi, es, fr, de, pt]`。简中与英文由上游自带，不覆写。
 */
export type DshPackLocale='zh-Hant'|'ja'|'ko'|'vi'|'es'|'fr'|'de'|'pt'
export type DshPackRow=readonly [key:string,...values:readonly string[]]

export const DSH_PACK_LOCALES:readonly DshPackLocale[]=['zh-Hant','ja','ko','vi','es','fr','de','pt']

export function dshPackDictionary(rows:readonly DshPackRow[],locale:DshPackLocale):Readonly<Record<string,string>>{
  const index=DSH_PACK_LOCALES.indexOf(locale)+1
  return Object.fromEntries(rows.map(row=>[row[0],row[index]!]))
}

/**
 * 按命名空间注册整份词表。
 * @param traditionalLocale - 繁体的目标语言标识由调用方给：上游对 zh-TW / zh-HK 各有自己的标识，
 *   词表只维护一份 zh-Hant。
 * @returns 注销函数清单，交由调用方在卸载时逐个调用。
 */
export function installDshLanguagePack(
  locale:DshLocalePort,
  traditionalLocale:'zh-Hant'|'zh-TW'|'zh-HK',
  namespaces:Readonly<Record<string,readonly DshPackRow[]>>,
):Array<()=>void>{
  const disposers:Array<()=>void>=[]
  const installedLocales:ReadonlyArray<readonly [string,DshPackLocale]>=[
    [traditionalLocale,'zh-Hant'],
    ...DSH_PACK_LOCALES.filter(id=>id!=='zh-Hant').map(id=>[id,id] as const),
  ]
  for(const [target,source] of installedLocales){
    for(const [namespace,rows] of Object.entries(namespaces))disposers.push(locale.register(namespace,target,dshPackDictionary(rows,source)))
  }
  return disposers
}
