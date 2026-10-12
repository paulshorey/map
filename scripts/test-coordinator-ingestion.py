#!/usr/bin/env python3
import concurrent.futures
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

def ident(): return str(uuid4())

import coordinator_ingestion as m

class MapControls(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name).resolve()
        self.repo=self.root/'map';self.repo.mkdir()
        self.git('init','-b','main');self.git('config','user.name','Diagnostic');self.git('config','user.email','diagnostic@example.invalid')
        self.git('remote','add','origin','https://github.com/paulshorey/map.git')
        (self.repo/'source.txt').write_text('baseline\n')
        self.git('add','.');self.git('commit','-m','baseline')
        self.base=self.git('rev-parse','HEAD');self.owner=ident()
        self.paths=patch.object(m,'ROOT',self.repo);self.paths.start()

    def git(self,*args):
        return subprocess.run(['git','-C',str(self.repo),*args],capture_output=True,text=True,check=True).stdout.strip()

    def tearDown(self):
        self.paths.stop();self.tmp.cleanup()
    def test_map_resume_uncapped_and_scope_preserved(self):
            run=ident()
            self.assertEqual(m.run_arguments(['--resume',run]),['--resume',run,'--unlimited'])
            for args in (['--resume',run,'--from','report'], ['--resume',run,'--max-cost-usd','1'],
                         ['--resume',run,'--resume',run], ['--resume',run,'--unknown','x']):
                with self.assertRaises(ValueError): m.run_arguments(args)

    def test_map_ambiguous_submission_keeps_claim(self):
            m.private_json(m.state()/'ingestion-acceptance.json',{'status':'verified'})
            empty={'control':{'quiescent':True,'maintenance':{'maintenance':False}},'jobs':[]}
            with patch.object(m,'snapshot',return_value=empty), patch.object(m,'command',side_effect=ValueError('lost receipt')):
                with self.assertRaises(ValueError): m.start(self.owner,['--resume',ident()])
                lease=m.state()/'imports/active.claim'
                self.assertTrue(lease.exists())
                row=m.read_json(lease.parent/lease.read_text().strip()/'intent.json')
                self.assertEqual(row['status'],'dispatching')
                with self.assertRaises(FileExistsError): m.start(ident(),['--resume',ident()])

    def test_map_busy_precheck_releases_without_submission(self):
            m.private_json(m.state()/'ingestion-acceptance.json',{'status':'verified'})
            busy={'control':{'quiescent':False,'maintenance':{'maintenance':False}},'jobs':[]}
            with patch.object(m,'snapshot',return_value=busy), patch.object(m,'command') as launch:
                with self.assertRaises(ValueError): m.start(self.owner,['--resume',ident()])
                launch.assert_not_called()
                self.assertFalse((m.state()/'imports/active.claim').exists())

    def test_map_discovery_two_distinct_passes(self):
            job,run,execution=ident(),ident(),ident()
            current={'control':{'workers':[{'run_id':run,'execution_id':execution}]},
                     'jobs':[{'id':job,'status':'running','run_id':run,'execution_id':execution}]}
            with patch.object(m,'snapshot',return_value=current):
                self.assertEqual(m.accept(self.owner,job)['status'],'observed_once')
                self.assertEqual(m.accept(self.owner,job)['status'],'observed_once')
                self.assertEqual(m.accept(ident(),job)['status'],'verified')

    def test_map_release_requires_exact_result_and_quiescence(self):
            intent,job=ident(),ident()
            directory=m.state()/'imports'
            m.private_json(directory/intent/'intent.json',{'id':intent,'job_id':job,'status':'started'})
            (directory/'active.claim').write_text(intent+'\n')
            current={'control':{'quiescent':True},'jobs':[{'id':job,'status':'running'}]}
            with patch.object(m,'snapshot',return_value=current):
                with self.assertRaises(ValueError): m.release(intent,'verified')
                current['jobs'][0]['status']='finished'
                with self.assertRaises(ValueError): m.release(intent,'verified')
                current['jobs'][0]['result_path']='private result'
                current['control']['quiescent']=False
                with self.assertRaises(ValueError): m.release(intent,'verified')
                current['control']['quiescent']=True
                self.assertEqual(m.release(intent,'actual terminal evidence')['status'],'reconciled')
                self.assertFalse((directory/'active.claim').exists())

    def test_stop_text_ack_is_only_a_request(self):
        job=ident();reply=subprocess.CompletedProcess([],0,'Stop requested. This is not proof of exit.\n','')
        with patch.object(m,'verify_checkout'),patch.object(m,'primary_root',return_value=self.repo),patch.object(m,'shell_environment',return_value={}),patch.object(m.subprocess,'run',return_value=reply) as launch:
            result=m.command(['ingest:supervise','stop','--job',job])
            self.assertEqual(result['status'],'stop_requested')
            self.assertEqual(result['job_id'],job)
            self.assertEqual(launch.call_args.args[0][-3:],['stop','--job',job])

    def test_shell_only_credentials_preserve_injected_values(self):
        (self.repo/'.env').write_text('PROJECT_SECRET=dotenv-value\n')
        (self.repo/'.env.example').write_text('PROJECT_SECRET=\n')
        marker=b'\0__MAP_COORDINATOR_ENV__\0'
        reply=subprocess.CompletedProcess([],0,marker+b'PROJECT_SECRET=shell-value\0DB_MAP_URL=database-fixture\0','')
        with patch.object(m,'primary_root',return_value=self.repo),patch.object(m.subprocess,'run',return_value=reply),patch.dict(os.environ,{'PROJECT_SECRET':'injected-value'},clear=True):
            env=m.shell_environment(('DB_MAP_URL',))
            self.assertEqual(env['PROJECT_SECRET'],'injected-value')
            self.assertEqual(env['DB_MAP_URL'],'database-fixture')
        with patch.object(m,'primary_root',return_value=self.repo),patch.object(m.subprocess,'run',return_value=reply),patch.dict(os.environ,{},clear=True):
            with self.assertRaises(ValueError):m.shell_environment(('MISSING',))

    def test_login_probe_uses_primary_map_directory(self):
        marker=b'\0__MAP_COORDINATOR_ENV__\0'
        reply=subprocess.CompletedProcess([],0,marker+b'DB_MAP_URL=database-fixture\0','')
        with patch.object(m,'primary_root',return_value=self.repo),patch.object(m.subprocess,'run',return_value=reply) as probe,patch.dict(os.environ,{},clear=True):
            self.assertEqual(m.shell_environment(('DB_MAP_URL',))['DB_MAP_URL'],'database-fixture')
        self.assertEqual(probe.call_args.kwargs['cwd'],self.repo)

if __name__=='__main__':
    os.umask(0o077);unittest.main(verbosity=2)
