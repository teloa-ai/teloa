/** 菜单坐标使用 CSS 视口像素，随缩放、滚动与内容高度变化重算。 */
export function composerPopoverPosition(anchor:{left:number;top:number;bottom:number},desiredWidth:number,height:number,viewportWidth:number,viewportHeight:number){
 const edge=12,gap=8,width=Math.min(desiredWidth,Math.max(0,viewportWidth-edge*2))
 const above=Math.max(0,Math.min(anchor.top,viewportHeight-edge)-gap-edge)
 const below=Math.max(0,viewportHeight-edge-Math.max(edge,anchor.bottom)-gap)
 const useAbove=above>=Math.min(height,480)||above>=below
 const maxHeight=Math.min(480,useAbove?above:below),visibleHeight=Math.min(height,maxHeight)
 return {left:Math.max(edge,Math.min(anchor.left,viewportWidth-edge-width)),top:useAbove?Math.max(edge,Math.min(anchor.top,viewportHeight-edge)-gap-visibleHeight):Math.max(edge,anchor.bottom)+gap,width,maxHeight}
}

/** 级联列表紧邻父菜单，优先向右，空间不足时向左；小视口由组件改为内联。 */
export function composerSubmenuPosition(anchor:{left:number;right:number;top:number},desiredWidth:number,height:number,viewportWidth:number,viewportHeight:number){
 const edge=12,gap=8,right=Math.max(0,viewportWidth-edge-anchor.right-gap),left=Math.max(0,anchor.left-gap-edge)
 const useRight=right>=desiredWidth||right>=left,width=Math.min(desiredWidth,useRight?right:left)
 const maxHeight=Math.min(480,Math.max(0,viewportHeight-edge*2)),visibleHeight=Math.min(height,maxHeight)
 return {left:useRight?anchor.right+gap:anchor.left-gap-width,top:Math.max(edge,Math.min(anchor.top,viewportHeight-edge-visibleHeight)),width,maxHeight}
}
