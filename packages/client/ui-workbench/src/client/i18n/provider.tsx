import {createContext, useContext, useMemo, useSyncExternalStore, type ReactNode} from 'react'
import {formatDate, formatDateTime, formatList, formatNumber, formatPercent, formatRelativeTime, formatTime, type DateInput} from './format.js'
import type {TeloaI18n, TeloaTranslate} from './index.js'
import type {ProductLocale} from './locale.js'

export type I18nValue = Readonly<{
  locale: ProductLocale
  t: TeloaTranslate
  date: (input: DateInput, options?: Intl.DateTimeFormatOptions) => string
  dateTime: (input: DateInput, options?: Intl.DateTimeFormatOptions) => string
  time: (input: DateInput, options?: Intl.DateTimeFormatOptions) => string
  relativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) => string
  number: (value: number, options?: Intl.NumberFormatOptions) => string
  percent: (value: number, options?: Intl.NumberFormatOptions) => string
  list: (values: readonly string[], options?: Intl.ListFormatOptions) => string
}>

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({runtime, children}: {runtime: TeloaI18n; children?: ReactNode}) {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  const value = useMemo<I18nValue>(() => ({
    locale: snapshot.locale,
    t: runtime.t,
    date: (input, options) => formatDate(snapshot.locale, input, options),
    dateTime: (input, options) => formatDateTime(snapshot.locale, input, options),
    time: (input, options) => formatTime(snapshot.locale, input, options),
    relativeTime: (number, unit, options) => formatRelativeTime(snapshot.locale, number, unit, options),
    number: (number, options) => formatNumber(snapshot.locale, number, options),
    percent: (number, options) => formatPercent(snapshot.locale, number, options),
    list: (values, options) => formatList(snapshot.locale, values, options),
  }), [runtime, snapshot])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (value === null) throw Error('Teloa i18n provider is not mounted')
  return value
}
