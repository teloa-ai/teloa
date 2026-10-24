import {BUSINESS_IMPORT_MESSAGE_KEYS,businessImportMessages,businessImportHongKongMessages,type BusinessImportMessageKey} from './locales/business-import.js'
import {TEMPLATE_SHARE_MESSAGE_KEYS,templateShareMessages,templateShareHongKongMessages} from './locales/template-share.js'
import {LIBRARY_MESSAGE_KEYS,libraryMessages,libraryHongKongMessages,type LibraryMessageKey} from './locales/library.js'
import {CAPABILITY_CENTER_MESSAGE_KEYS,capabilityCenterMessages,capabilityCenterHongKongMessages,type CapabilityCenterMessageKey} from './locales/capability-center.js'
import {LOCAL_MATERIAL_MESSAGE_KEYS,localMaterialMessages,type LocalMaterialMessageKey} from './locales/local-material.js'
import {PLAN_WORK_MESSAGE_KEYS,planWorkMessages,type PlanWorkMessageKey} from './locales/plan-work.js'
import {TASK_COMPLETION_MESSAGE_KEYS,taskCompletionMessages,type TaskCompletionMessageKey} from './locales/task-completion.js'
import {MAIN_LOCALES, REGION_LOCALES, fallbackChain, type MainLocale, type RegionLocale} from './locale.js'
import {zhCNMessages} from './locales/zh-CN.js'
import {zhHantMessages} from './locales/zh-Hant.js'
import {enMessages} from './locales/en.js'
import {jaMessages} from './locales/ja.js'
import {koMessages} from './locales/ko.js'
import {viMessages} from './locales/vi.js'
import {esMessages} from './locales/es.js'
import {frMessages} from './locales/fr.js'
import {deMessages} from './locales/de.js'
import {ptMessages} from './locales/pt.js'
import {zhTWMessages} from './regions/zh-TW.js'
import {zhHKMessages} from './regions/zh-HK.js'
import {CORE_PAGE_MESSAGE_ROWS} from './locales/core-pages.js'
import {OVERVIEW_MESSAGE_KEYS,overviewMessages,overviewHongKongMessages,type OverviewMessageKey} from './locales/overview.js'
import {ROLE_DELEGATION_MESSAGE_KEYS,roleDelegationMessages,roleDelegationHongKongMessages,type RoleDelegationMessageKey} from './locales/role-delegation.js'
import {COMPOSER_SUGGESTION_MESSAGE_KEYS,composerSuggestionMessages,type ComposerSuggestionMessageKey} from './locales/composer-suggestion.js'

const BASE_MESSAGE_KEYS = [
  'app.name',
  'app.edition.personal',
  'navigation.home',
  'navigation.attention',
  'navigation.team',
  'navigation.spaces',
  'navigation.resources',
  'navigation.tasks',
  'navigation.plans',
  'navigation.projects',
  'navigation.newConversation',
  'navigation.creating',
  'navigation.new',
  'navigation.search',
  'navigation.main',
  'navigation.recent',
  'navigation.recent.remove',
  'navigation.reading',
  'navigation.profileAria',
  'home.title',
  'home.subtitle',
  'home.mode.conversation',
  'home.mode.work',
  'home.action.newConversation',
  'home.action.newTask',
  'home.action.newGroup',
  'home.action.newRole',
  'home.attentionCount',
  'home.handleTogether',
  'home.continue',
  'home.emptyStart',
  'home.emptyDescription',
  ...CORE_PAGE_MESSAGE_ROWS.map(row=>row[0]),
  'team.action.new',
  'team.search',
  'team.empty.unconfigured',
  'team.empty.noMatch',
  'team.empty.unconfiguredDescription',
  'team.empty.noMatchDescription',
  'team.empty.reset',
  'team.detail.back',
  'team.action.assign',
  'team.action.edit',
  'task.action.viewAll',
  'task.search',
  'task.empty.none',
  'task.empty.noMatch',
  'task.detail.back',
  'task.detail.goal',
  'continuous.directory',
  'continuous.tab.plans',
  'continuous.tab.runs',
  'continuous.search',
  'continuous.empty.plans',
  'continuous.empty.runs',
  'continuous.detail.back',
  'continuous.action.create',
  'continuous.sandbox.title',
  'continuous.action.createSandbox',
  'status.running',
  'status.completed',
  'status.failed',
  'status.stale',
  'status.enabled',
  'status.paused',
  'status.archived',
  'common.allBusiness',
  'common.allStatus',
  'common.closeError',
  'common.retry',
  'settings.connecting',
  'settings.disconnected',
  'settings.reconnect',
  'settings.loading',
  'settings.general',
  'settings.workspace',
  'settings.about',
  'settings.configurationHelp',
  'settings.document.open',
  'settings.document.opening',
  'settings.document.unavailable',
  'profile.title',
  'profile.description',
  'profile.displayName',
  'profile.save',
  'profile.saved',
  'about.studio',
  'about.local',
  'about.tagline',
  'about.connections',
  'about.contactSupport',
  'about.contactBusiness',
  'about.author',
  'about.developer',
  'about.wechat',
  'about.addWechat',
  'about.officialAccount',
  'about.followAccount',
  'about.support',
  'about.supportDescription',
  'about.rewardCaption',
  'about.close',
  'about.foundationDescription',
  'shell.skipToWorkspace',
  'shell.workspace.mine',
  'shell.navigation.open',
  'shell.breadcrumbAria',
  'shell.navigation.close',
  'shell.conversationDirectory',
  'shell.messageType.label',
  'shell.messageType.ai',
  'shell.messageType.group',
  'shell.artifacts',
  'shell.taskTemplate.save',
  'shell.settings',
  'error.invalidInput',
  'error.forbidden',
  'error.notFound',
  'error.conflict',
  'error.versionConflict',
  'error.sourceUnavailable',
  'error.storageUnavailable',
  'error.configurationFailed',
  'error.unknown',
] as const

export const MESSAGE_KEYS=[...BASE_MESSAGE_KEYS,...BUSINESS_IMPORT_MESSAGE_KEYS,...TEMPLATE_SHARE_MESSAGE_KEYS,...OVERVIEW_MESSAGE_KEYS,...ROLE_DELEGATION_MESSAGE_KEYS,...TASK_COMPLETION_MESSAGE_KEYS,...PLAN_WORK_MESSAGE_KEYS,...LOCAL_MATERIAL_MESSAGE_KEYS,...CAPABILITY_CENTER_MESSAGE_KEYS,...LIBRARY_MESSAGE_KEYS,...COMPOSER_SUGGESTION_MESSAGE_KEYS] as const
export type MessageKey = typeof MESSAGE_KEYS[number]
export type MessageCatalog = Readonly<Record<typeof BASE_MESSAGE_KEYS[number], string>&Partial<Record<BusinessImportMessageKey|OverviewMessageKey|RoleDelegationMessageKey|TaskCompletionMessageKey|PlanWorkMessageKey|LocalMaterialMessageKey|CapabilityCenterMessageKey|LibraryMessageKey|ComposerSuggestionMessageKey,string>>>
export type RegionCatalog = Readonly<Partial<Record<MessageKey, string>>>
export type MessageParams = Readonly<Record<string, string | number>>

export const catalogs: Readonly<Record<MainLocale, Readonly<Record<MessageKey,string>>>> = {
  'zh-CN': {...businessImportMessages['zh-CN'],...zhCNMessages,...overviewMessages['zh-CN'],...roleDelegationMessages['zh-CN'],...taskCompletionMessages['zh-CN'],...planWorkMessages['zh-CN'],...localMaterialMessages['zh-CN'],...capabilityCenterMessages['zh-CN'],...libraryMessages['zh-CN'],...templateShareMessages['zh-CN'],...composerSuggestionMessages['zh-CN']},
  'zh-Hant': {...businessImportMessages['zh-Hant'],...zhHantMessages,...overviewMessages['zh-Hant'],...roleDelegationMessages['zh-Hant'],...taskCompletionMessages['zh-Hant'],...planWorkMessages['zh-Hant'],...localMaterialMessages['zh-Hant'],...capabilityCenterMessages['zh-Hant'],...libraryMessages['zh-Hant'],...templateShareMessages['zh-Hant'],...composerSuggestionMessages['zh-Hant']},
  en: {...businessImportMessages.en,...enMessages,...overviewMessages.en,...roleDelegationMessages.en,...taskCompletionMessages.en,...planWorkMessages.en,...localMaterialMessages.en,...capabilityCenterMessages['en'],...libraryMessages['en'],...templateShareMessages['en'],...composerSuggestionMessages.en},
  ja: {...businessImportMessages.en,...jaMessages,...overviewMessages.en,...roleDelegationMessages.en,...taskCompletionMessages.en,...planWorkMessages.en,...localMaterialMessages.en,...capabilityCenterMessages['en'],...libraryMessages['en'],...templateShareMessages['en'],...composerSuggestionMessages.en},
  ko: {...businessImportMessages.en,...koMessages,...overviewMessages.en,...roleDelegationMessages.en,...taskCompletionMessages.en,...planWorkMessages.en,...localMaterialMessages.en,...capabilityCenterMessages['en'],...libraryMessages['en'],...templateShareMessages['en'],...composerSuggestionMessages.en},
  vi: {...businessImportMessages.en,...viMessages,...overviewMessages.en,...roleDelegationMessages.en,...taskCompletionMessages.en,...planWorkMessages.en,...localMaterialMessages.en,...capabilityCenterMessages['en'],...libraryMessages['en'],...templateShareMessages['en'],...composerSuggestionMessages.en},
  es: {...businessImportMessages.en,...esMessages,...overviewMessages.en,...roleDelegationMessages.en,...taskCompletionMessages.en,...planWorkMessages.en,...localMaterialMessages.en,...capabilityCenterMessages['en'],...libraryMessages['en'],...templateShareMessages['en'],...composerSuggestionMessages.en},
  fr: {...businessImportMessages.en,...frMessages,...overviewMessages.en,...roleDelegationMessages.en,...taskCompletionMessages.en,...planWorkMessages.en,...localMaterialMessages.en,...capabilityCenterMessages['en'],...libraryMessages['en'],...templateShareMessages['en'],...composerSuggestionMessages.en},
  de: {...businessImportMessages.en,...deMessages,...overviewMessages.en,...roleDelegationMessages.en,...taskCompletionMessages.en,...planWorkMessages.en,...localMaterialMessages.en,...capabilityCenterMessages['en'],...libraryMessages['en'],...templateShareMessages['en'],...composerSuggestionMessages.en},
  pt: {...businessImportMessages.en,...ptMessages,...overviewMessages.en,...roleDelegationMessages.en,...taskCompletionMessages.en,...planWorkMessages.en,...localMaterialMessages.en,...capabilityCenterMessages['en'],...libraryMessages['en'],...templateShareMessages['en'],...composerSuggestionMessages.en},
}

export const regionCatalogs: Readonly<Record<RegionLocale, RegionCatalog>> = {
  'zh-TW': zhTWMessages,
  'zh-HK': {...zhHKMessages,...businessImportHongKongMessages,...overviewHongKongMessages,...roleDelegationHongKongMessages,...capabilityCenterHongKongMessages,...libraryHongKongMessages,...templateShareHongKongMessages},
}

type LooseMainCatalogs = Readonly<Record<string, Readonly<Record<string, string>>>>
type LooseRegionCatalogs = Readonly<Record<string, Readonly<Partial<Record<string, string>>>>>

export function validateCatalogs(main: LooseMainCatalogs, regions: LooseRegionCatalogs): void {
  const expected = new Set<string>(MESSAGE_KEYS)
  const mainLocales = new Set<string>(MAIN_LOCALES)
  const regionLocales = new Set<string>(REGION_LOCALES)
  for (const locale of Object.keys(main)) if (!mainLocales.has(locale)) throw Error(`unknown main catalog ${locale}`)
  for (const locale of Object.keys(regions)) if (!regionLocales.has(locale)) throw Error(`unknown region catalog ${locale}`)
  for (const locale of MAIN_LOCALES) {
    const catalog = main[locale]
    if (catalog === undefined) throw Error(`missing main catalog ${locale}`)
    for (const key of MESSAGE_KEYS) {
      if (!Object.hasOwn(catalog, key)) throw Error(`catalog ${locale} missing key ${key}`)
      if (!catalog[key]?.trim()) throw Error(`catalog ${locale} has empty entry ${key}`)
    }
    for (const key of Object.keys(catalog)) if (!expected.has(key)) throw Error(`catalog ${locale} has unknown key ${key}`)
  }
  for (const locale of REGION_LOCALES) {
    const catalog = regions[locale]
    if (catalog === undefined) throw Error(`missing region catalog ${locale}`)
    for (const [key, value] of Object.entries(catalog)) {
      if (!expected.has(key)) throw Error(`region ${locale} has unknown key ${key}`)
      if (typeof value !== 'string' || !value.trim()) throw Error(`region ${locale} has empty entry ${key}`)
    }
  }
}

validateCatalogs(catalogs, regionCatalogs)

function interpolate(template: string, params?: MessageParams): string {
  if (params === undefined) return template
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  )
}

export function translateMessage(locale: string, key: MessageKey, params?: MessageParams): string {
  for (const candidate of fallbackChain(locale)) {
    const value = candidate === 'zh-TW' || candidate === 'zh-HK'
      ? regionCatalogs[candidate][key]
      : catalogs[candidate][key]
    if (value !== undefined) return interpolate(value, params)
  }
  return key
}
