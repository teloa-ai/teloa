// 固定 DSH 基线的主题投影逻辑，来源和 MIT 许可见 THIRD_PARTY_NOTICES.md。
/**
 * Global theme DOM applier: projects the resolved ThemeSnapshot onto the
 * document — `html { color-scheme }` for native UA chrome (scrollbars, form
 * controls), `body[data-ds-dark-theme]` for the token palette, the active
 * theme's alias-token overrides as inline CSS variables on body, the content
 * font-size axis (`--dsh-content-font-size`), and one presenter-owned
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
  /** Token names this presenter wrote in the last apply (its retraction set). */
  private appliedTokens: string[] = []
  private readonly originalTypography = new Map(['font-family','font-size','line-height'].map(name=>[name,{value:document.body.style.getPropertyValue(name),priority:document.body.style.getPropertyPriority(name)}]))
  private readonly appliedTypography = new Map<string,string>()
  /** The single metadata node this presenter inserts and removes. */
  private readonly themeColorMeta: HTMLMetaElement

  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
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
    body.style.setProperty(CONTENT_FONT_SIZE_VARIABLE, `${snapshot.fontSize}px`)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    const palette=prototypeThemes[scheme]
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
    native['--dsw-font-family']=palette['--teloa-design-font']!
    for(const [name,key] of [['font-family','font'],['font-size','text-base'],['line-height','lh']] as const){body.style.setProperty(name,palette['--teloa-design-'+key]!);this.appliedTypography.set(name,body.style.getPropertyValue(name))}
    for (const [name, value] of Object.entries({...snapshot.active.tokens,...palette,...native})) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  /** Retract root color-scheme, the palette attribute, token variables, the font-size axis, and the owned metadata node. */
  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    body.style.removeProperty(CONTENT_FONT_SIZE_VARIABLE)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for(const [name,value] of this.appliedTypography)if(body.style.getPropertyValue(name)===value){const original=this.originalTypography.get(name)!;if(original.value)body.style.setProperty(name,original.value,original.priority);else body.style.removeProperty(name)}
    this.appliedTypography.clear()
    this.themeColorMeta.remove()
  }
}
