import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createPublicReferenceCatalog } from './local.ts'
import { createReferenceServer } from './server.ts'

const catalog=createPublicReferenceCatalog()
const server=createReferenceServer(catalog)
await server.connect(new StdioServerTransport())
