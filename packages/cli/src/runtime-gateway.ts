import {loadAdmission,loadHost,guardedGateway} from './runtime-admission.ts'
export default guardedGateway(await loadHost('@deepseek-ai/dsh-api-gateway','0.2.1-alpha.1'),await loadAdmission())
