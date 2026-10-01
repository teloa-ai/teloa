import type {BusinessTarget} from './business-preview.js'
import type {BusinessDataMode} from './business-page-mode.js'
import {nextBusinessHome} from './business-home-presentation.ts'

/**
 * `WorkbenchFrame` 里业务/同事那一段装配层的决策，全部收在这里做纯函数，
 * 外壳只负责把来由报进来、把返回的值写进 state/ref/store。
 */

/** 业务目标的取值指纹：比的是取值而不是对象身份，两处（effect 依赖与恢复期落定）共用一条算法。 */
export const businessTargetKey = (target: BusinessTarget): string =>
    JSON.stringify([target.scope, target.section, target.id ?? null, target.objectType ?? null, ...(target.dashboardId === undefined ? [] : [target.dashboardId]), ...(target.recordReference === undefined ? [] : [target.recordReference.scope,target.recordReference.type,target.recordReference.id,target.recordReference.version,target.recordReference.snapshotHash]), ...(target.match === undefined ? [] : [target.match.field, target.match.value])])

/** 「已见」取值：视图与业务目标各一份，用来判断这次变化是不是用户的动作。 */
export type BusinessNavSeen = {viewSeen: string; targetSeen: string}

/**
 * 报给装配层的来由：
 * - `view`/`target`：两条 effect 观察到的新取值。
 * - `enter`：调用方明确要进某个范围的内页（卡片、`enterBusiness`）。
 * - `back-home`：页头「← 业务台账」。
 * - `settle`：启动恢复期落定目标——只推平已见取值，不算用户打开了一个范围。
 */
export type BusinessNavSignal =
    | {kind: 'view'; view: string}
    | {kind: 'target'; target: BusinessTarget}
    | {kind: 'enter'}
    | {kind: 'back-home'}
    | {kind: 'settle'; target: BusinessTarget}

/** 一次装配的结果：新的已见取值，以及首页/内页这一位要不要翻（`null` 表示不翻）。 */
export type BusinessNavStep = {seen: BusinessNavSeen; home: boolean | null}

/**
 * 首页/内页这一位与两份「已见」取值的唯一决策口（终审 H1、L4、M4）。
 *
 * - `enter` 顺手把「已见视图」推到 `spaces`：`openBusiness` 会切到业务视图，不先推平的话紧接着的视图
 *   effect 会按「回到业务视图就回首页」把这一位又翻回去。
 * - `settle` 只推平「已见目标」；恢复到的若是一个精确内页位置（非总览或带 id），那是用户上次停的地方，直接进内页。
 * - `view`：只有真的换到了业务视图才回首页。
 * - `target`：目标取值真变了才算用户打开了一个范围。
 */
export function businessNavStep(seen: BusinessNavSeen, signal: BusinessNavSignal): BusinessNavStep {
    const home = (origin: Parameters<typeof nextBusinessHome>[0]['origin'], changed: {view?: boolean; target?: boolean} = {}) =>
        nextBusinessHome({origin, viewChanged: changed.view === true, targetChanged: changed.target === true})
    switch (signal.kind) {
        case 'view':
            return {seen: {...seen, viewSeen: signal.view}, home: home('view', {view: seen.viewSeen !== signal.view && signal.view === 'spaces'})}
        case 'target': {
            const key = businessTargetKey(signal.target)
            return {seen: {...seen, targetSeen: key}, home: home('target', {target: seen.targetSeen !== key})}
        }
        case 'enter':
            return {seen: {...seen, viewSeen: 'spaces'}, home: home('enter')}
        case 'back-home':
            return {seen, home: home('back-home')}
        case 'settle': {
            const precise = signal.target.section !== 'overview' || signal.target.id !== undefined
            return {seen: {...seen, targetSeen: businessTargetKey(signal.target)}, home: precise ? home('enter') : null}
        }
    }
}

/** 范围内页的进入态：`serial` 换 key，确保重新读取当前正式台账。 */
export type BusinessEntry = {serial: number}

/** 每次从台账首页进内页都换一个新 `serial`，让 `BusinessPage` 重新挂载。 */
export const nextBusinessEntry = (current: BusinessEntry): BusinessEntry => ({serial: current.serial + 1})

/** 从台账首页进某个范围要做的两件事。 */
export type OpenBusinessScopeSteps = {seedExamples: boolean; target: BusinessTarget}

/**
 * 卡片「打开」与「试一试」共用这一个决策，差别只在 `mode`：
 * 示例模式进去之前要先备好演示数据（`seedExamples`），否则是一页空的沙盒。
 */
export const openBusinessScopeSteps = (
    input: {scope: string; mode: BusinessDataMode; businessLoaded: boolean},
): OpenBusinessScopeSteps => ({
    seedExamples: input.mode === 'sandbox' && !input.businessLoaded,
    target: {scope: input.scope, section: 'overview'},
})

/** 「查看同事 →」交给同事页的三件事。 */
export type StaffOfScopeSteps = {selectedRole: null; focusScope: string; view: 'team'}

/**
 * 先清掉选中的同事再置聚焦范围：不清的话 `TeamPage` 的 `selected` 还指向旧的那一位，
 * 用户会落在个人主页而不是这队名单（第一期规格 §9.4）。
 */
export const openStaffOfScopeSteps = (scope: string): StaffOfScopeSteps => ({selectedRole: null, focusScope: scope, view: 'team'})

/** 聚焦范围只在同事页里有意义：离开同事页就清空。 */
export const teamFocusScopeAfterView = (view: string, current: string | null): string | null => (view === 'team' ? current : null)

/** 业务台账首页什么时候占住主视图：只有业务视图、这一位停在首页、且不是右栏页签那份。 */
export const businessLedgerHomeShown = (input: {view: string; home: boolean; embedded: boolean}): boolean =>
    input.view === 'spaces' && input.home && !input.embedded

/** 范围内页什么时候可见：右栏页签那份恒可见，主视图那份要让位给台账首页。 */
export const businessPageVisible = (input: {embedded: boolean; view: string; ledgerHome: boolean}): boolean =>
    (input.embedded || input.view === 'spaces') && !input.ledgerHome

/**
 * 范围内页的挂载参数：右栏 `teloa.business` 页签不带进入态（`entry` 缺席），
 * 于是它的 key 恒为 `business-tab`；首页点卡不会把它重挂。
 */
export const businessPageEntryProps = (entry?: BusinessEntry): {key: string; props: Record<string, never>} => ({
    key: 'business-' + (entry?.serial ?? 'tab'),
    props: {},
})
