import {createElement,Fragment,type ReactNode} from 'react'

export type ArtifactPanelView='preview'|'files'|'versions'
type DirectoryItem={id:string;primary:boolean;updatedAt:string;versions?:readonly number[]}
type StoredArtifact={storage?:'persistent'}

export function artifactPanelArtifacts<T extends StoredArtifact>(artifacts:readonly T[],persistentSource:boolean):T[]{
 return artifacts.filter(artifact=>(artifact.storage==='persistent')===persistentSource)
}

export function artifactPanelStart(rows:readonly DirectoryItem[],requested?:string,strict=false,requestedVersion?:number){
 if(!rows.length)return requested&&strict?{mode:'missing' as const,selected:null}:{mode:'create' as const,selected:null}
 const requestedRow=rows.find(item=>item.id===requested)
 if(strict&&requested&&(!requestedRow||requestedVersion!==undefined&&!requestedRow.versions?.includes(requestedVersion)))return {mode:'missing' as const,selected:null}
 const selected=requestedRow||rows.find(item=>item.primary)||[...rows].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0]!
 return {mode:'read' as const,selected:selected.id}
}

export function artifactPanelViews():readonly ArtifactPanelView[]{return ['preview','files','versions']}

export function artifactPanelMoreActions(storage?:'persistent',locked=false){
 const persistent=storage==='persistent'
 return {
  showLinkAndReview:!persistent,
  showFollow:!persistent&&locked,
  showRevision:!locked,
  capabilityBoundary:persistent?(locked?'locked':'active'):null,
 }
}

export type ArtifactPanelMoreActionsProps={
 actions:ReturnType<typeof artifactPanelMoreActions>
 activeBoundary:string
 lockedBoundary:string
 link:ReactNode
 review:ReactNode
 follow:ReactNode
 revision:ReactNode
 exportAction:ReactNode
}

export function ArtifactPanelMoreActions({actions,activeBoundary,lockedBoundary,link,review,follow,revision,exportAction}:ArtifactPanelMoreActionsProps){
 return createElement(Fragment,null,
  actions.capabilityBoundary==='active'&&createElement('p',null,activeBoundary),
  actions.capabilityBoundary==='locked'&&createElement('p',null,lockedBoundary),
  actions.showLinkAndReview&&link,
  actions.showLinkAndReview&&review,
  actions.showFollow&&follow,
  actions.showRevision&&revision,
  exportAction,
 )
}
