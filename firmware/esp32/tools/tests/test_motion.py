import json
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
class PetMotionTests(unittest.TestCase):
    def test_display_chinese_labels_have_embedded_glyphs(self):
        font=(ROOT/'main/teloa/assets/teloa_cjk_20.c').read_text()
        start=int(re.search(r'\.range_start=(\d+)',font).group(1))
        codes={int(value)+start for value in re.search(r'codes\[\]=\{([^}]*)\}',font).group(1).split(',')}
        display=(ROOT/'main/teloa/teloa_display.cc').read_text()
        missing={c for text in re.findall(r'"([^"\n]*)"',display) for c in text
                 if 0x3400<=ord(c)<=0x9fff and ord(c) not in codes}
        self.assertEqual(sorted(missing),[],f'屏幕字库缺字：{"".join(sorted(missing))}')
    def test_generated_motion_matches_one_definition(self):
        subprocess.run(['python3',str(ROOT/'tools/build_motion.py'),'--check'],check=True)
    def test_life_motion_and_touch_boundaries(self):
        compiler=shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'pet-test'
            subprocess.run([compiler,'-std=c++17','-Wall','-Wextra','-Werror','-I',str(ROOT/'main/teloa'),
                str(ROOT/'tools/tests/teloa_motion_test.cc'),str(ROOT/'main/teloa/teloa_motion.cc'),'-o',str(output)],check=True)
            subprocess.run([str(output)],check=True)
    def test_approval_and_pairing_have_still_frames(self):
        spec=json.loads((ROOT/'main/teloa/motion.json').read_text())
        for mode in ('approval','pairing'):
            frames=spec['clips'][mode]['frames']
            self.assertTrue(all((f['x'],f['y'],f['angle'],f['sx'],f['sy'])==(0,0,0,256,256) for f in frames))
if __name__=='__main__':unittest.main()
