import {loadAdmission,loadHost,guardedWebServer} from './runtime-admission.ts'
export default guardedWebServer(await loadHost('@deepseek-ai/dsh-host-webserver'),await loadAdmission())
