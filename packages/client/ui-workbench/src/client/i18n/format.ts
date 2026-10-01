import {intlLocale} from './locale.js'

export type DateInput = Date | string | number

function dateValue(input: DateInput): Date {
  const value = input instanceof Date ? new Date(input.getTime()) : new Date(input)
  if (!Number.isFinite(value.getTime())) throw Error('date must be valid')
  return value
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw Error('number must be finite')
  return value
}

export function formatDateTime(locale: string, input: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(dateValue(input))
}

export function formatDate(locale: string, input: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const configured = options.dateStyle !== undefined || ['weekday', 'era', 'year', 'month', 'day'].some(key => options[key as keyof Intl.DateTimeFormatOptions] !== undefined)
  return formatDateTime(locale, input, configured ? options : {...options, dateStyle: 'medium'})
}

export function formatTime(locale: string, input: DateInput, options: Intl.DateTimeFormatOptions = {}): string {
  const configured = options.timeStyle !== undefined || ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeZoneName'].some(key => options[key as keyof Intl.DateTimeFormatOptions] !== undefined)
  return formatDateTime(locale, input, configured ? options : {...options, timeStyle: 'short'})
}

export function formatRelativeTime(locale: string, value: number, unit: Intl.RelativeTimeFormatUnit, options: Intl.RelativeTimeFormatOptions = {numeric: 'auto'}): string {
  return new Intl.RelativeTimeFormat(intlLocale(locale), options).format(finite(value), unit)
}

export function formatNumber(locale: string, value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(finite(value))
}

export function formatPercent(locale: string, value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(intlLocale(locale), {...options, style: 'percent'}).format(finite(value))
}

export function formatList(locale: string, values: readonly string[], options: Intl.ListFormatOptions = {}): string {
  return new Intl.ListFormat(intlLocale(locale), options).format(values)
}
