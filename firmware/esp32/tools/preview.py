"""生成离线屏幕预览；使用与固件相同的角色、动作定义和布局，不连接任何服务。"""
import argparse,base64,io,json
from pathlib import Path
from build_mascot import decode_pack
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    root=Path(__file__).resolve().parents[1];assets=root/'main/teloa/assets'
    sprites=[]
    for image in decode_pack((assets/'mascot.pet').read_bytes()):
        output=io.BytesIO();image.save(output,format='PNG',optimize=True)
        sprites.append('data:image/png;base64,'+base64.b64encode(output.getvalue()).decode())
    html=(root/'tools/preview.html').read_text().replace('__SPRITES__',json.dumps(sprites)).replace('__ANIMATION__',(root/'artwork/companion/animation.json').read_text()).replace('__MOTION__',(root/'main/teloa/motion.json').read_text()).replace('__SCRIPT__',(root/'tools/preview.js').read_text())
    with args.output.open('x',encoding='utf-8') as output:output.write(html)
if __name__=='__main__':main()
