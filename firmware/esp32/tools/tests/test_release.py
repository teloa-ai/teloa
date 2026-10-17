import hashlib
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cryptography.hazmat.primitives.asymmetric import rsa
from release import sign_manifest,verify_manifest,ReleaseError,extract_factory_app,trial_otadata

class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
    def test_signed_candidate_rejects_each_incompatible_or_tampered_field(self):
        image=bytearray(4096);image[0]=0xe9;image[12]=9
        image=bytes(image);partition=b'partition-fixture'
        fields={'releaseId':'teloa-bubble-dev-1','boardId':'teloa-bubble','chip':'esp32s3','partitionSha256':hashlib.sha256(partition).hexdigest(),'configSchema':1,'resourceVersion':1,'appVersion':'teloa-dev-1','appSha256':hashlib.sha256(image).hexdigest(),'appSize':len(image),'sourceRevision':'a'*40}
        signed=sign_manifest(fields,self.key)
        self.assertTrue(verify_manifest(signed,image,partition,self.key.public_key()))
        for key,value in [('boardId','other'),('chip','esp32'),('configSchema',2),('resourceVersion',2),('partitionSha256','b'*64),('appSha256','c'*64),('appSize',0x3f0001),('sourceRevision','d'*40),('signature','AAAA')]:
            with self.subTest(key=key),self.assertRaises(ReleaseError):verify_manifest({**signed,key:value},image,partition,self.key.public_key())
        with self.assertRaises(ReleaseError):verify_manifest({**signed,'url':'https://example.invalid'},image,partition,self.key.public_key())
        with self.assertRaises(ReleaseError):verify_manifest(signed,image+b'x',partition,self.key.public_key())


class RecoveryCandidateTests(unittest.TestCase):
    def test_extract_rejects_corrupted_original_image(self):
        import struct
        image=bytearray(24);image[0]=0xe9;image[1]=1;image[12]=9;image[23]=1
        image.extend(struct.pack('<II',0x3c000000,3));image.extend(b'abc')
        checksum=0xef
        for byte in b'abc':checksum^=byte
        image.extend(b'\0'*(15-len(image)%16));image.append(checksum);image.extend(hashlib.sha256(image).digest())
        self.assertEqual(extract_factory_app(image,offset=0),image)
        image[33]^=1
        with self.assertRaises(ReleaseError):extract_factory_app(image,offset=0)
    def test_trial_selects_new_slot_zero_with_valid_original_slot_one(self):
        import struct,zlib
        data=trial_otadata();self.assertEqual(len(data),8192)
        for offset,sequence,state in [(0,3,0),(4096,2,2)]:
            self.assertEqual(struct.unpack_from('<I',data,offset)[0],sequence)
            self.assertEqual(struct.unpack_from('<I',data,offset+24)[0],state)
            self.assertEqual(struct.unpack_from('<I',data,offset+28)[0],zlib.crc32(data[offset:offset+4],0xffffffff))
