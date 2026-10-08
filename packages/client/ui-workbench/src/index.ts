import type { Context } from '@deepseek-ai/cordis'
import { apply as installNativeSettingsHost } from '@deepseek-ai/dsh-client-ui-settings-general'
import { installWebShellBrand } from './web-shell.ts'

/** 复用原生设置的 Host 注册；替换浏览器外壳不能丢失首次引导的持久化契约。刷新首页在工作台挂载前也显示 Teloa 品牌。 */
export const name = 'teloa-ui-workbench'
export function apply(ctx: Context): void {installNativeSettingsHost(ctx);installWebShellBrand(ctx)}
