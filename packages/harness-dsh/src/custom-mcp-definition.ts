import {createHash} from 'node:crypto'
import {pageCreateCanonicalBody,type CustomMcpDefinition} from '@teloa/contract'
export {readCustomMcpDefinition,type CustomMcpDefinition} from '@teloa/contract'

export function customMcpDefinitionHash(value:CustomMcpDefinition):string{return createHash('sha256').update(pageCreateCanonicalBody(value)).digest('hex')}
