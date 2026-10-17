import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
class SpriteTests(unittest.TestCase):
    def test_native_decoder_matches_all_production_frame_hashes(self):
        compiler=shutil.which('clang++') or shutil.which('g++')
        self.assertIsNotNone(compiler)
        assets=ROOT/'main/teloa/assets'
        manifest=json.loads((assets/'mascot-manifest.json').read_text())
        self.assertEqual(hashlib.sha256((assets/'mascot.pet').read_bytes()).hexdigest(),manifest['packSha256'])
        with tempfile.TemporaryDirectory() as directory:
            runner=Path(directory)/'sprite-test'
            subprocess.run([compiler,'-std=c++17','-O2','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',
                '-I',str(ROOT/'main/teloa'),str(ROOT/'tools/tests/teloa_sprite_test.cc'),str(ROOT/'main/teloa/teloa_sprite.cc'),'-lz','-o',str(runner)],check=True)
            output=Path(directory)/'decoded.bgra'
            subprocess.run([str(runner),str(assets/'mascot.pet'),str(output)],check=True)
            data=output.read_bytes();size=176*176*4
            self.assertEqual(len(data),54*size)
            for i,digest in enumerate(manifest['decodedBgraSha256']):
                self.assertEqual(hashlib.sha256(data[i*size:(i+1)*size]).hexdigest(),digest)
    def test_production_pack_is_reproducible(self):
        # 资产工具单独使用固定 Pillow；协议测试环境无需安装绘图库。
        python=shutil.which('python3')
        self.assertIsNotNone(python)
        subprocess.run([python,str(ROOT/'tools/build_mascot.py'),'--check'],check=True)

if __name__=='__main__':unittest.main()
