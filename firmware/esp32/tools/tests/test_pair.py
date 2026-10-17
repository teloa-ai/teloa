import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import pair
from teloa import FirmwareError

class PairTests(unittest.TestCase):
    def run_pair(self,lost=False,cancel=False):
        calls=[];writes=[];saved=False
        def ipc(row):
            calls.append(row)
            if row['operation']=='status':return {'state':'cancelled' if cancel else 'awaiting-device','expiresAt':time.time()*1000+10000,'host':'192.168.2.10','serverName':'teloa.test'}
            if row['operation']=='provision':return {'configuration':'secret-config','digest':'a'*64}
            if row['operation']=='complete':return {'state':'paired'}
            self.fail('unexpected IPC')
        def exchange(_serial,row):
            nonlocal saved
            writes.append(row)
            if row['type']=='pair.status':return {'type':'pair.status','intentId':'intent','nonce':'nonce','confirmed':True,**({'configDigest':'a'*64} if saved else {})}
            if row['type']=='pair.begin':return {'type':'pair.waiting'}
            if row['type']=='pair.configure':
                saved=True
                if lost:raise FirmwareError('lost ACK')
                return {'type':'pair.saved','digest':'a'*64}
            self.fail('unexpected USB')
        with patch.object(pair,'exchange',exchange):
            if cancel:
                with self.assertRaises(FirmwareError):pair.pair('intent',ipc,object())
            else:self.assertEqual(pair.pair('intent',ipc,object()),{'state':'paired'})
        self.assertEqual(sum(row['type']=='pair.configure' for row in writes),0 if cancel else 1)
        return calls
    def test_success_and_lost_ack_use_same_job(self):
        for lost in (False,True):self.assertEqual(sum(row['operation']=='complete' for row in self.run_pair(lost)),1)
    def test_cancel_does_not_write_configuration(self):self.run_pair(cancel=True)
    def test_default_cli_never_opens_serial(self):
        with patch.object(sys,'argv',['pair','--intent','id','--socket','missing']),patch.object(pair,'enumerate_ports',side_effect=AssertionError('serial access')):
            pair.main()
