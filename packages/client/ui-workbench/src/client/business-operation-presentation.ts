import type { BusinessOperation } from './business-preview.js'
import type {MessageKey} from './i18n/messages.js'

/** 操作列表只呈现已声明的执行路径，不据此推断真实连接或执行结果。 */
export function executionRouteLabel(operation:BusinessOperation):MessageKey{
  if(operation.policy)return 'business.execution.route.policy'
  if(operation.approval)return 'business.execution.route.approval'
  return 'business.execution.route.manual'
}
