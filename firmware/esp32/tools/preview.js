const $=s=>document.querySelector(s),screen=$('#screen'),pet=$('.squirrel'),sprite=pet.querySelector('img'),primary=$('.primary'),secondary=$('.secondary'),name=$('.name'),status=$('.status'),subtitle=$('.subtitle'),approval=$('.approval'),hint=$('#hint'),activity=$('.activity'),desk=$('.desk'),shadow=$('.shadow'),effect=$('.effect'),dots=[...document.querySelectorAll('.dot')];
const labels={idle:'陪你待一会儿',stroll:'散个步',tail:'摇摇尾巴',look:'四处看看',read:'翻翻书',rest:'休息一下',stretch:'伸个懒腰',listening:'我在听',working:'正在处理',speaking:'正在播报',waiting:'等待你确认',pairing:'USB 配对',happy:'完成了',pet:'摸摸头，收到啦'};
const pages=['write_file\n在工作目录创建测试文件','文件：测试记录.txt\n内容：联调通过。','仅批准本次操作。\n长按右下方按钮确认。'];
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let state='idle',card=false,page=0,quiet=reduced.matches,started=performance.now(),reactAt=null,blendAt=started,from={x:0,y:0,angle:0,sx:256,sy:256},frame={...from},held=null,headerHeld=null,lastPose='',lastPaint=0;
$('#quiet').checked=quiet;
const ease=p=>p*p*(3-2*p),mix=(a,b,p)=>Math.round(a+(b-a)*p);
function sample(mode,elapsed){const clip=motion.clips[mode]||motion.clips.idle,frames=clip.frames,end=frames.at(-1).at,time=clip.loop?elapsed%end:Math.min(elapsed,end);let i=0;while(i+1<frames.length&&frames[i+1].at<=time)i++;const a=frames[i],b=frames[Math.min(i+1,frames.length-1)],p=a.at===b.at?0:ease((time-a.at)/(b.at-a.at));return {...a,...Object.fromEntries(['x','y','angle','sx','sy'].map(k=>[k,mix(a[k],b[k],p)]))}}
function transition(now){from={...frame};blendAt=now;}
function selectSprite(elapsed,pose,frozen){
 if(state!=='idle'||reactAt!==null||frozen)return {index:pose};
 const length=phase=>phase.clip?animation.clips[phase.clip].reduce((a,b)=>a+b,0)*(phase.repeats||1):phase.duration;
 const total=animation.daily.reduce((sum,phase)=>sum+length(phase),0);let time=elapsed%total;
 for(const phase of animation.daily){if(time>=length(phase)){time-=length(phase);continue;}
  if(!phase.clip)return {index:phase.pose,activity:phase.activity,prop:phase.prop||'none'};
  const durations=animation.clips[phase.clip];time%=durations.reduce((a,b)=>a+b,0);let i=0;while(time>=durations[i])time-=durations[i++];
  return {index:6+Object.keys(animation.clips).indexOf(phase.clip)*16+i,activity:phase.activity,prop:'none'};
 }
 return {index:0,activity:'idle',prop:'none'};
}
function select(next){const now=performance.now();transition(now);state=next;started=now;reactAt=null;held=null;card=false;approval.hidden=true;name.textContent='小罗同学';status.textContent=next==='pairing'?'长按屏幕确认配对':'';subtitle.textContent=({idle:'',listening:'',thinking:'',speaking:'我是小罗同学。',happy:'',pairing:'示例主机 · 预览不会真实配对'})[next]||'';primary.textContent='待确认';secondary.textContent=next==='listening'||next==='speaking'?'结束':'说话';document.querySelectorAll('[data-state]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.state===state)));hint.textContent=next==='idle'?'它在自己的小房间里，陪你待一会儿。':'演示状态 · 不连接设备或宿主';paint(now);}
function paint(now){const frozen=quiet||reduced.matches||card||state==='pairing';screen.dataset.state=state;screen.dataset.quiet=String(frozen);document.querySelectorAll('.scene').forEach(el=>el.hidden=card||state==='pairing');if(card)return;
 if(reactAt!==null&&now-reactAt>=1500){transition(now);reactAt=null;started=now}
 let target=sample(reactAt===null?state:'pet',frozen?0:now-(reactAt===null?started:reactAt));const p=frozen?1:ease(Math.min((now-blendAt)/motion.transitionMs,1));frame={...target,...Object.fromEntries(['x','y','angle','sx','sy'].map(k=>[k,mix(from[k],target[k],p)]))};
 const selected=selectSprite(now-started,frame.pose,frozen);
 if(selected.activity){Object.assign(frame,{x:0,y:0,angle:0,sx:256,sy:256,activity:selected.activity,prop:selected.prop})}
 if(['listening','speaking'].includes(state))Object.assign(frame,{x:0,y:0,angle:0,sx:256,sy:256});
 if(selected.index!==lastPose){sprite.src=sprites[selected.index];lastPose=selected.index}
 pet.style.left=(92+frame.x)+'px';pet.style.top=(80+frame.y)+'px';pet.style.transform='rotate('+(frame.angle/10)+'deg) scale('+(frame.sx/256)+','+(frame.sy/256)+')';pet.dataset.pose=String(selected.index);pet.dataset.activity=frame.activity;
 shadow.style.left=(120+frame.x)+'px';shadow.style.width=(120+Math.trunc((frame.sy-256)/2))+'px';desk.hidden=card||state==='pairing'||frame.prop!=='desk';desk.style.top=(222+(frame.signal===1?1:0))+'px';effect.hidden=frozen||frame.prop!=='sparkle';effect.style.top=(107-frame.signal*3)+'px';
 dots.forEach((dot,i)=>{dot.hidden=frozen||!['listening','speaking','thinking'].includes(state);dot.style.top=(state==='thinking'?111:245)+'px';dot.style.height=(state==='thinking'?6:i===frame.signal?12:5)+'px';dot.style.opacity=i===frame.signal?'1':'.4'});
 activity.textContent=quiet||reduced.matches?'安静模式':labels[frame.activity];}
function animate(now){if(now-lastPaint>=motion.frameMs){lastPaint=now;paint(now)}requestAnimationFrame(animate)}
function petting(){if(card||state!=='idle'||quiet||reduced.matches)return;const now=performance.now();transition(now);reactAt=now;hint.textContent='摸摸头，收到啦。没有开启麦克风。';paint(now)}
pet.addEventListener('click',petting);
function drawCard(){held=null;card=true;approval.hidden=false;approval.textContent=pages[page];name.textContent='等待你确认';status.textContent=(page+1)+' / '+pages.length;secondary.textContent='拒绝';primary.textContent=page<pages.length-1?'下一页':'长按批准';paint(performance.now());hint.textContent='演示审批 · 小松鼠暂停活动，等你决定';}
function finish(text){select('idle');subtitle.textContent=text;hint.textContent='仅完成预览操作，未提交真实审批';}
primary.addEventListener('pointerdown',e=>{held={at:performance.now(),id:e.pointerId};});
primary.addEventListener('pointerup',e=>{const elapsed=held&&held.id===e.pointerId?performance.now()-held.at:0;held=null;if(state==='pairing')return;if(!card){page=0;drawCard()}else if(page<pages.length-1){page++;drawCard()}else if(elapsed>=1200)finish('已批准本次操作。');else hint.textContent='请重新长按 1.2 秒批准本次操作。';});
primary.addEventListener('pointercancel',()=>held=null);primary.addEventListener('pointerleave',()=>held=null);
primary.addEventListener('keydown',e=>{if(e.key==='Enter'&&!card){page=0;drawCard()}});
secondary.addEventListener('click',()=>{if(state==='pairing')return;if(card)finish('已拒绝本次操作。');else select(state==='listening'||state==='speaking'?'idle':'listening')});
function setQuiet(value){quiet=value;$('#quiet').checked=value;reactAt=null;transition(performance.now());started=performance.now();paint(started)}
$('#quiet').addEventListener('change',e=>setQuiet(e.target.checked));reduced.addEventListener('change',()=>{if(reduced.matches)setQuiet(true);paint(performance.now())});
$('#theme').addEventListener('click',()=>document.body.classList.toggle('dark'));
screen.addEventListener('pointerdown',e=>{const box=screen.getBoundingClientRect();if(e.clientY-box.top<85&&!card&&state!=='pairing')headerHeld={at:performance.now(),id:e.pointerId};});
screen.addEventListener('pointerup',e=>{if(headerHeld&&headerHeld.id===e.pointerId&&performance.now()-headerHeld.at>=900)setQuiet(!quiet);headerHeld=null});
screen.addEventListener('pointercancel',()=>headerHeld=null);screen.addEventListener('pointerleave',()=>headerHeld=null);
document.querySelectorAll('[data-state]').forEach(b=>b.addEventListener('click',()=>select(b.dataset.state)));
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&card){select('idle');hint.textContent='已返回，未提交审批。'}});
select('idle');requestAnimationFrame(animate);
