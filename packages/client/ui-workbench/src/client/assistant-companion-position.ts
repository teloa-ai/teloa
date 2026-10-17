type Point={x:number;y:number}
type Rect=Point&{width:number;height:number}

/** 按输入框和按钮的 DOM 语义找原编辑区，不依赖 DSH 私有样式、翻译或服务状态。 */
export function companionInputRegions(companion:HTMLElement):HTMLElement[]{
 const regions=new Set<HTMLElement>()
 for(const input of document.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"]')){
  if(companion.contains(input)||input.closest('[aria-hidden="true"],[inert]'))continue
  const box=input.getBoundingClientRect()
  if(!box.width||!box.height)continue
  let region=input
  for(let parent=input.parentElement;parent&&parent!==document.body;parent=parent.parentElement){
   const candidate=parent.getBoundingClientRect()
   if(candidate.height>Math.max(260,box.height+150)||candidate.width>box.width+256)break
   if(parent.querySelectorAll('textarea,[contenteditable="true"]').length===1&&parent.querySelector('button')){region=parent;break}
  }
  regions.add(region)
 }
 return [...regions]
}

/** 首选最近的空位；仅调整显示坐标，不改用户位置。空间不足仍保持原视口边界。 */
export function companionSafePoint(point:Point,size:Pick<Rect,'width'|'height'>,viewport:Rect,regions:readonly Rect[]):Point{
 const margin=8,minX=viewport.x+margin,minY=viewport.y+margin,maxX=Math.max(minX,viewport.x+viewport.width-size.width-margin),maxY=Math.max(minY,viewport.y+viewport.height-size.height-margin)
 const clamp=(value:Point)=>({x:Math.max(minX,Math.min(value.x,maxX)),y:Math.max(minY,Math.min(value.y,maxY))})
 const origin=clamp(point),obstacles=regions.filter(rect=>rect.width>0&&rect.height>0&&rect.x<viewport.x+viewport.width&&rect.y<viewport.y+viewport.height&&rect.x+rect.width>viewport.x&&rect.y+rect.height>viewport.y)
 const clear=(value:Point)=>!obstacles.some(rect=>value.x<rect.x+rect.width+margin&&value.x+size.width+margin>rect.x&&value.y<rect.y+rect.height+margin&&value.y+size.height+margin>rect.y)
 if(clear(origin))return origin
 const xs=new Set([origin.x,minX,maxX,...obstacles.flatMap(rect=>[clamp({x:rect.x-size.width-margin,y:origin.y}).x,clamp({x:rect.x+rect.width+margin,y:origin.y}).x])]),ys=new Set([origin.y,minY,maxY,...obstacles.flatMap(rect=>[clamp({x:origin.x,y:rect.y-size.height-margin}).y,clamp({x:origin.x,y:rect.y+rect.height+margin}).y])])
 let best:Point|undefined,distance=Infinity
 for(const x of xs)for(const y of ys){const candidate={x,y},d=(x-origin.x)**2+(y-origin.y)**2;if(d<distance&&clear(candidate)){best=candidate;distance=d}}
 return best??origin
}
