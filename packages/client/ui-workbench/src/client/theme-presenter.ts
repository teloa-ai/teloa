// 固定 DSH 基线的主题投影逻辑，来源和 MIT 许可见 THIRD_PARTY_NOTICES.md。
/**
 * Global theme DOM applier: projects the resolved ThemeSnapshot onto the
 * document — `html { color-scheme }` for native UA chrome (scrollbars, form
 * controls), `body[data-ds-dark-theme]` for the token palette, the active
 * theme's alias-token overrides as inline CSS variables on body, the content
 * font sizes and families by role, and one presenter-owned
 * `meta[name="theme-color"]` for surrounding browser UI. Pure DOM writes, no
 * React involvement; the presenter only ever retracts what it wrote itself,
 * so foreign attributes, metadata, and inline styles survive.
 */
import { prototypeThemes } from '../brand/prototype-theme.js'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Body attribute selecting the dark base palette in the token stylesheets. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** Body variable carrying the user's content font size in px. */
export const CONTENT_FONT_SIZE_VARIABLE = '--dsh-content-font-size'

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  /** Capture original styles once and restore only values still owned by this presenter. */
  private readonly appliedStyles = new Map<string,{original:string;priority:string;value:string}>()
  /** The single metadata node this presenter inserts and removes. */
  private readonly themeColorMeta: HTMLMetaElement

  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
  }

  private retractStyle(name:string):void {
    const prior=this.appliedStyles.get(name)
    if(!prior)return
    const style=document.body.style
    if(style.getPropertyValue(name)===prior.value&&style.getPropertyPriority(name)===''){
      if(prior.original)style.setProperty(name,prior.original,prior.priority)
      else style.removeProperty(name)
    }
    this.appliedStyles.delete(name)
  }

  private projectStyles(values:Record<string,string|null>):void {
    for(const name of this.appliedStyles.keys())if(!(name in values))this.retractStyle(name)
    const style=document.body.style
    for(const [name,value] of Object.entries(values)){
      const prior=this.appliedStyles.get(name)??{original:style.getPropertyValue(name),priority:style.getPropertyPriority(name),value:''}
      if(value===null)style.removeProperty(name)
      else style.setProperty(name,value)
      this.appliedStyles.set(name,{...prior,value:style.getPropertyValue(name)})
    }
  }

  /**
   * Project a snapshot onto the document: set root `color-scheme` and the body
   * palette attribute from `active.colorScheme` (never the id — `system` is
   * resolved upstream), publish the content font-size axis, then replace the
   * previously applied token variables with `active.tokens`. Browser
   * theme-color metadata follows the computed body background after those
   * writes, so the rendered palette remains the color authority.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    const base=prototypeThemes[scheme]
    const textFont=snapshot.fontFamilies?.text||base['--teloa-design-font']!
    const textSize=`${snapshot.fontSizes.text}px`
    // 留空沿用 Teloa 默认；本人设置同时作用于工作台和原生页面。
    const palette:Record<string,string>={...base,'--teloa-design-font':textFont,'--teloa-design-text-base':textSize}
    // 仅通过公开设计变量适配原生页面；不依赖原生 DOM 或内部类名。
    const native:Record<string,string>={}
    for(const [name,key] of Object.entries({
      'bg-base':'bg','bg-layer-1':'surface','bg-layer-2':'subtle','bg-layer-3':'hover','bg-overlay':'surface',
      'bg-module-platform':'sidebar','bg-multi-select':'accent-bg','bg-mask-1':'overlay','bg-mask-2':'overlay',
      'label-primary':'text','label-primary-bluish':'text','label-primary-dimmed':'text','label-secondary':'muted','label-tertiary':'muted','label-caption':'muted','label-dimmed':'muted','label-primary-inverted':'surface',
      'border-l1':'border','border-l2':'border','border-l3':'border','border-l4':'border',
      'brand-primary':'accent','brand-text':'accent','brand-primary-invert':'on-accent',
      'interactive-bg-hover':'hover','interactive-bg-active':'hover','interactive-bg-hover-accent':'accent-bg',
    }))native['--dsw-alias-'+name]=palette['--teloa-design-'+key]!
    native['--dsw-font-family']=textFont
    this.projectStyles({...snapshot.active.tokens,...palette,...native,
      [CONTENT_FONT_SIZE_VARIABLE]:textSize,
      '--dsh-code-font-size':`${snapshot.fontSizes.code??11}px`,
      '--dsh-terminal-font-size':`${snapshot.fontSizes.terminal??13}px`,
      '--dsh-font-family-text':snapshot.fontFamilies?.text||null,
      '--dsh-font-family-code':snapshot.fontFamilies?.code||null,
      '--dsh-font-family-terminal':snapshot.fontFamilies?.terminal||null,
      'font-family':textFont,'font-size':textSize,'line-height':base['--teloa-design-lh']!,
    })
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  /** Retract root color-scheme, the palette attribute, token variables, the font-size axis, and the owned metadata node. */
  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    for(const name of this.appliedStyles.keys())this.retractStyle(name)
    this.themeColorMeta.remove()
  }
}
