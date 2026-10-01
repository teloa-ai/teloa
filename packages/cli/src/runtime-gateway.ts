import {loadAdmission,loadHost,guardedGateway} from './runtime-admission.ts'
export default guardedGateway(await loadHost('@deepseek-ai/dsh-api-gateway','0.1.7-rc.1'),await loadAdmission())
