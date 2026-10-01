export type DatabaseChoice={kind:'docker'}|{kind:'existing';configFile:string}
export type Layout={home:string;releaseRoot:string;instanceRoot:string;dshHome:string;runtimeRoot:string;workspaceRoot:string}
export type InstallState={schema:'teloa.install/v1';id:string;version:string;layout:Layout;port:number;database:DatabaseChoice;phase:'prepared'|'ready'|'stopped'|'maintenance'|'failed'}
export type ProcessIdentity={pid:number;startedAt:string;nonce:string;installId:string}
export type Status={app:'stopped'|'starting'|'ready'|'failed'|'unknown';database:'ready'|'unavailable'|'unknown';version:string;port:number;activeWork:number}
export type ReleaseManifest={schema:'teloa.release/v1';version:string;dshVersion:string;dataVersion:number;compatibleDataVersions:number[];files:Array<{path:string;sha256:string}>}
export type BackupManifest={schema:'teloa.backup/v1';id:string;createdAt:string;installId:string;version:string;dataVersion:number;files:Array<{path:string;sha256:string}>;externalWorkspaceIncluded:false}
