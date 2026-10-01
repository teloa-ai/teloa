import type { Context } from '@deepseek-ai/cordis'
import { apply as installNativeSettingsHost } from '@deepseek-ai/dsh-client-ui-settings-general'

/** 复用原生设置的 Host 注册；替换浏览器外壳不能丢失首次引导的持久化契约。 */
export const name = 'teloa-ui-workbench'
export function apply(ctx: Context): void {installNativeSettingsHost(ctx)}
