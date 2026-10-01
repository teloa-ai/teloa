import type { BusinessScopeKind, BusinessScopeLabel } from './business-directory.js';
import type { IndustryDataSourceInstance } from './industry-data-source-api.js';
import type { IndustryLoadRecord } from './industry-load-api.js';
import type { AttentionItem } from './attention-item.js';
import type { PreviewRole } from './role-preview.js';
import type { PreviewTask } from './task-preview.js';
import type { TeloaTranslate } from './i18n/index.js';
import { COMPOSITION_ROWS, composeFromWorkspace, compositionSummary, type CompositionCount, type CompositionRowId, type CompositionTarget } from './industry-composition.ts';
import { roleSupportsScope } from '@teloa/contract';

export type BusinessHomeCard = {
    scope: string;
    title: string;
    kind: BusinessScopeKind;
    sources: number;
    staff: readonly PreviewRole[];
    attention: number;
    /** 当前范围内尚未结项的正式任务数；演示任务不进入业务首页。 */
    working: number;
    /** 业务范围唯一的模板来源称呼；未声明或不唯一时由组件回落通用名词。 */
    sourceNoun?: string;
    /** 这张卡上「这个业务有什么」的七行计数；空行不在其中，卡上据此只说有的那几段。 */
    composition: CompositionCount[];
    situationKey: 'business.home.situation.connected' | 'business.home.situation.none' | 'business.home.situation.connectedNoStaff' | 'business.home.situation.noneNoStaff';
    lineKey: 'business.home.line.connected' | 'business.home.line.none';
};

/** 翻「业务台账首页 / 范围内页」这一位的来由：视图换了、目标换了、明确要进内页、明确要回首页。 */
export type BusinessHomeOrigin = 'view' | 'target' | 'enter' | 'back-home';

/**
 * 首页/内页这一位的唯一判据（终审 H1、M4）。返回 `null` 表示「这次不翻」。
 *
 * - `enter`：调用方明确要进某个范围的内页（卡片、`enterBusiness`、恢复到一个精确内页位置），
 *   一律置 false。它**不看** `targetChanged`：从别处打开的目标常常与当前目标深度相等
 *   （冷启动默认就是 `{scope:'SOC',section:'overview'}`），只靠「目标取值变了」判会把用户留在首页。
 * - `target`：目标取值真的变了才算用户打开了一个范围；恢复期先 `settleBusinessTarget` 把已见取值推平，
 *   这里就读到「没变」，不翻这一位。
 * - `view`：换到业务视图（左栏点「业务」）回首页；视图没变不翻。
 */
export const nextBusinessHome = (
    signal: { origin: BusinessHomeOrigin; viewChanged: boolean; targetChanged: boolean },
): boolean | null =>
    signal.origin === 'enter' ? false
        : signal.origin === 'back-home' ? true
            : signal.origin === 'view' ? (signal.viewChanged ? true : null)
                : signal.targetChanged ? false : null;

/** 数据源数只认已经完成授权的正式实例；模板声明、待授权、漂移回退与已解除实例都不算已接入。 */
export const businessHomeSources = (dataSources: readonly IndustryDataSourceInstance[], scope: string): number =>
    dataSources.filter(instance => instance.scope === scope && instance.state === 'active').length;

/** 在岗同事：这一范围里既没暂停也没退役的数字员工；分身（`twin`）不算在岗人手。 */
export const businessHomeStaff = (roles: readonly PreviewRole[], scope: string): readonly PreviewRole[] =>
    roles.filter(role => role.kind === 'employee' && role.state === 'active' && roleSupportsScope(role.scopes, scope));

/** 等你数：与左栏徽标的 `formalAttentionCount` 同一口径（排除演示数据），只多一层范围过滤。 */
export const businessHomeAttention = (items: readonly AttentionItem[], scope: string): number =>
    items.filter(item => item.scope === scope && item.persistence !== 'example').length;

/** 业务首页的「正在处理」只读取已保存且未结项的任务，不能把演示任务或历史结果伪装成当前工作。 */
export const businessHomeWorking = (tasks: readonly PreviewTask[], scope: string): number =>
    tasks.filter(task => task.storage === 'persistent' && task.scope === scope && task.state !== 'completed' && task.state !== 'cancelled').length;

/** 卡片顺序：内置范围在前，模板登记的域次之，迁移期遗留标签垫底；同类按标题的当地语序排。 */
const KIND_ORDER: Record<BusinessScopeKind, number> = { builtin: 0, domain: 1, legacy: 2 };

export function businessHomeCards(
    labels: readonly BusinessScopeLabel[],
    snapshot: { roles: readonly PreviewRole[]; dataSources: readonly IndustryDataSourceInstance[]; attention: readonly AttentionItem[]; tasks: readonly PreviewTask[]; locale: string; loads?: readonly IndustryLoadRecord[]; plans?: readonly { scope: string; state: string; title: string }[] },
): BusinessHomeCard[] {
    return labels
        .map((label): BusinessHomeCard => {
            const sources = businessHomeSources(snapshot.dataSources, label.scope);
            const staff = businessHomeStaff(snapshot.roles, label.scope);
            return {
                scope: label.scope,
                // 卡摘要与范围内页面板读同一份计数，不在首页另算一套。
                composition: composeFromWorkspace({ scope: label.scope, loads: snapshot.loads ?? [], roles: snapshot.roles, ...(snapshot.plans ? { plans: snapshot.plans } : {}) }).map(section => section.count),
                title: label.title,
                kind: label.kind,
                sources,
                staff,
                attention: businessHomeAttention(snapshot.attention, label.scope),
                working: businessHomeWorking(snapshot.tasks, label.scope),
                ...(label.sourceNoun===undefined?{}:{sourceNoun:label.sourceNoun}),
                // 处境句两件事各说各的：接没接上来源、有没有同事在这儿（原型 `situationOf` 的两段拼法）。
                situationKey: staff.length
                    ? (sources ? 'business.home.situation.connected' : 'business.home.situation.none')
                    : (sources ? 'business.home.situation.connectedNoStaff' : 'business.home.situation.noneNoStaff'),
                lineKey: sources ? 'business.home.line.connected' : 'business.home.line.none',
            };
        })
        .sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || left.title.localeCompare(right.title, snapshot.locale));
}

/**
 * 摘要每一段的落点与面板里同类条目的「去配置」同一处，不另起一套跳法：
 * 共享的技能与接入只有一处配置页，业务自有的东西回到这个业务里。
 */
const summaryTarget = (id: CompositionRowId, scope: string): CompositionTarget =>
    id === 'staff' ? { kind: 'team', scope }
        : id === 'skill' ? { kind: 'capabilities' }
            : id === 'knowledge' ? { kind: 'knowledge' }
                : id === 'source' ? { kind: 'connectors' }
                    : id === 'extension' ? { kind: 'market', category: 'plugin' }
                        : { kind: 'business', scope };

/** 摘要的一段：`go` 有值的是可点的名词计数，没有的是分隔符。 */
export type BusinessHomeSummaryPart = { text: string; go?: CompositionTarget };

/**
 * 把一行摘要切成可点的段：文字与分隔一律现问 `compositionSummary`——
 * 单独一行问出这一段的说法，相邻两行问出中间的分隔符，首页因此不会出现第二套计数或分隔写法。
 */
export function businessHomeSummaryParts(
    rows: readonly CompositionCount[],
    scope: string,
    t: TeloaTranslate,
    number: (value: number) => string,
): BusinessHomeSummaryPart[] {
    const speak = (...values: readonly CompositionCount[]) => compositionSummary(values, t, number);
    const shown = COMPOSITION_ROWS.flatMap(row => {
        const found = rows.find(item => item.id === row.id);
        return found && speak(found) ? [found] : [];
    });
    return shown.flatMap((row, index): BusinessHomeSummaryPart[] => {
        const part = { text: speak(row), go: summaryTarget(row.id, scope) };
        if (!index) return [part];
        const previous = speak(shown[index - 1]!), joined = speak(shown[index - 1]!, row);
        return [{ text: joined.slice(previous.length, joined.length - part.text.length) }, part];
    });
}
