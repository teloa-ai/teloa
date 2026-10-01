import {WorkError,type SecurityActionDefinitionCatalog} from '@teloa/contract'
import {createSecurityEndpointIsolateDefinition} from '@teloa/backend'

/** 唯一 P0 目录由宿主组装；领域服务不持有 HTTP 或凭据。 */
export function createSecurityActionDefinitionCatalog():SecurityActionDefinitionCatalog{
 const definition=Object.freeze(createSecurityEndpointIsolateDefinition())
 return Object.freeze({require(tool:string){if(tool!==definition.tool)throw new WorkError('teloa/forbidden','安全动作工具未获声明。');return definition}})
}
