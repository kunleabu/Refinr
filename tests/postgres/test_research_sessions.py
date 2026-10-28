"""Disposable LOCAL PostgreSQL regression tests; never use Supabase credentials."""
import os, json, uuid, hashlib, unittest, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import psycopg
from psycopg.types.json import Jsonb
DSN=os.environ['RESEARCH_TEST_DSN']
from psycopg.conninfo import conninfo_to_dict
config=conninfo_to_dict(DSN)
assert config.get('host') in {'127.0.0.1','localhost'}, 'Disposable LOCAL database only'
assert config.get('dbname')=='refinr_phase2a_review', 'Dedicated disposable test database required'
SQL=Path(__file__).resolve().parents[2] / 'supabase/migrations/20261007000100_research_sessions_phase2a.sql'
def conn(role='service_role'):
    c=psycopg.connect(DSN,autocommit=True)
    c.execute('SET ROLE '+role)
    c.execute("SET statement_timeout='5s'")
    return c

def digest(obj): return hashlib.sha256(json.dumps(obj,sort_keys=True).encode()).hexdigest()
def rpc(c,name,*args):
    vals=[Jsonb(v) if isinstance(v,(dict,list)) else v for v in args]
    return c.execute('SELECT public.'+name+'('+','.join(['%s']*len(vals))+')',vals).fetchone()[0]
def paper(key,doi=None,source='openalex',sid=None,title='Learning in schools',year=2020,given='Jane',family='Smith'):
    return {'id':key,'doi':doi,'title':title,'year':year,'authors':[{'given':given,'family':family}],
      'provenance':[{'source':source,'id':sid or key,'rank':1}], 'identifiers':{'doi':doi,source:sid or key},
      'citationCounts':{source:10},'sourceRecords':[],'abstract':'School learning','type':'article-journal'}

class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.actor=uuid.uuid4(); self.c=conn(); self.admin=conn('postgres')
        self.admin.execute('INSERT INTO auth.users(id) VALUES(%s)',[self.actor])
        self.s=rpc(self.c,'create_research_session',self.actor,uuid.uuid4(),digest('create'),'learning',{'topic':'learning'})['session']
        self.session=uuid.UUID(self.s['id'])
        self.pull=rpc(self.c,'begin_research_pull',self.actor,self.session,0,uuid.uuid4(),digest('pull'),'initial',{})
        self.pid=uuid.UUID(self.pull['pullId'])
    def tearDown(self):
        self.admin.execute('DELETE FROM auth.users WHERE id=%s',[self.actor]); self.c.close();self.admin.close()
    def expire(self):
        self.admin.execute("UPDATE public.research_retrievals SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",[self.pid])
    def retry(self,key=None,hash_=None,version=None,c=None):
        return rpc(c or self.c,'retry_failed_research_sources',self.actor,self.session,self.pid,
          version if version is not None else self.pull['receiptVersion'],key or uuid.uuid4(),hash_ or digest('retry'))
    def upsert(self,p): return rpc(self.c,'research_upsert_paper',self.actor,self.session,self.pid,p)
    def roots(self): return self.c.execute('SELECT count(*) FROM public.research_session_papers WHERE session_id=%s AND merged_into_id IS NULL',[self.session]).fetchone()[0]
    def conflict(self,fn,code='PT409',message=None):
        with self.assertRaises(psycopg.Error) as raised: fn()
        self.assertEqual(raised.exception.sqlstate,code)
        if message:self.assertIn(message,str(raised.exception))
    def test_expired_retry_without_livelock(self):
        self.expire();r=self.retry();self.assertEqual(r['disposition'],'execute');self.assertEqual(r['receiptVersion'],3)
        self.assertNotEqual(r['attemptToken'],self.pull['attemptToken'])
    def test_simultaneous_different_keys_one_execution(self):
        self.expire(); barrier=threading.Barrier(2)
        def run():
            with conn() as c:
                barrier.wait()
                try:return self.retry(c=c)['disposition']
                except psycopg.Error as e:return e.sqlstate
        with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(lambda _:run(),range(2)))
        self.assertEqual(sorted(r),['PT409','execute'])
        self.assertEqual(self.c.execute('SELECT attempt_no FROM public.research_retrievals WHERE id=%s',[self.pid]).fetchone()[0],2)
    def test_simultaneous_same_key_one_execution(self):
        self.expire();barrier=threading.Barrier(2);key=uuid.uuid4()
        def run():
            with conn() as c:barrier.wait();return self.retry(key,c=c)
        with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(lambda _:run(),range(2)))
        self.assertEqual(sorted(x['disposition'] for x in r),['execute','in_progress'])
        self.assertEqual(self.c.execute('SELECT attempt_no FROM public.research_retrievals WHERE id=%s',[self.pid]).fetchone()[0],2)
    def test_old_retry_version_and_old_callback_cannot_overwrite(self):
        self.expire(); newer=self.retry()
        self.conflict(lambda:self.retry(version=1),message='STALE_RECEIPT')
        self.conflict(lambda:rpc(self.c,'fail_research_pull',self.actor,self.session,self.pid,uuid.UUID(self.pull['attemptToken']),1,digest('old'),'TIMEOUT'),message='STALE_ATTEMPT')
        self.assertEqual(self.c.execute('SELECT attempt_token::text FROM public.research_retrievals WHERE id=%s',[self.pid]).fetchone()[0],newer['attemptToken'])
    def test_same_retry_key_replay_and_payload_conflict(self):
        self.expire();key=uuid.uuid4();r=self.retry(key)
        replay=self.retry(key);self.assertEqual(replay['disposition'],'in_progress');self.assertNotIn('attemptToken',replay)
        self.conflict(lambda:self.retry(key,digest('different payload')),message='IDEMPOTENCY_KEY_REUSED')
        rpc(self.c,'fail_research_pull',self.actor,self.session,self.pid,uuid.UUID(r['attemptToken']),r['receiptVersion'],digest('failure'),'TIMEOUT')
        self.assertEqual(self.retry(key)['disposition'],'replay')
        next_=self.retry(version=r['receiptVersion']+1)
        self.assertEqual(self.retry(key)['disposition'],'in_progress')
        self.assertEqual(self.c.execute('SELECT attempt_token::text FROM public.research_retrievals WHERE id=%s',[self.pid]).fetchone()[0],next_['attemptToken'])
    def test_retry_preserves_advanced_failed_state_and_skips_success(self):
        cont={'version':1,'query':'learning','yearFrom':None,'yearTo':None,'sources':{'openalex':{'cursor':'advanced'},'crossref':{'offset':40}}}
        self.admin.execute('UPDATE public.research_retrievals SET input_continuation=%s,output_continuation=%s,attempt_sources=%s WHERE id=%s',[Jsonb(cont),Jsonb(cont),Jsonb(cont['sources']),self.pid])
        outcomes={'openalex':{'status':'ok','returned':1,'total':100,'continuation':None},'crossref':{'status':'error'}}
        done=rpc(self.c,'complete_research_pull',self.actor,self.session,self.pid,uuid.UUID(self.pull['attemptToken']),1,digest(outcomes),outcomes,[])
        r=self.retry(version=done['receiptVersion']);self.assertEqual(r['attemptSources'],{'crossref':{'offset':40}})
    def test_lease_bounds_and_live_attempt_denial(self):
        seconds=self.c.execute('SELECT extract(epoch from lease_expires_at-created_at) FROM public.research_retrievals WHERE id=%s',[self.pid]).fetchone()[0]
        self.assertGreaterEqual(seconds,44);self.assertLessEqual(seconds,46)
        self.conflict(lambda:self.retry(),message='PULL_IN_PROGRESS')
    def test_doi_alias_reconciles(self):
        a=self.upsert(paper('doi:10.1234/abc','10.1234/abc',sid='W1'))
        b=self.upsert(paper('doi:10.1234/abc','10.1234/abc',source='crossref',sid='10.1234/abc'))
        self.assertEqual(a,b);self.assertEqual(self.roots(),1)
        p=self.c.execute('SELECT metadata FROM public.research_session_papers WHERE id=%s',[a]).fetchone()[0]
        self.assertEqual({x['source'] for x in p['provenance']},{'openalex','crossref'})
    def test_source_alias_reconciles_metadata_update(self):
        a=self.upsert(paper('openalex:W1',sid='W1',given=''))
        b=self.upsert(paper('openalex:W1',sid='W1',title='Learning at school',given=''))
        self.assertEqual(a,b);self.assertEqual(self.roots(),1)
    def test_exact_normalized_bibliography_reconciles(self):
        a=self.upsert(paper('openalex:W1',sid='W1',title='  LEARNING   in schools '))
        b=self.upsert(paper('crossref:X',source='crossref',sid='X',given='jane',family='SMITH'))
        self.assertEqual(a,b)
    def test_similar_bibliography_remains_distinct(self):
        for i,kwargs in enumerate([{'title':'Learning in school'},{'year':2021},{'given':'Janet'},{'title':'Learning in schools?'}]):
            # Different provider IDs, one bibliographic difference at a time.
            a=self.upsert(paper('openalex:base'+str(i),sid='base'+str(i),title='Learning in schools',year=2020+i*10))
            changed={'title':'Learning in schools','year':2020+i*10,**kwargs}
            b=self.upsert(paper('crossref:diff'+str(i),source='crossref',sid='diff'+str(i),**changed))
            self.assertNotEqual(a,b)
    def test_incomplete_authors_never_fallback_match(self):
        a=self.upsert(paper('openalex:W1',sid='W1',given=''))
        b=self.upsert(paper('crossref:X',source='crossref',sid='X',given=''))
        self.assertNotEqual(a,b)
    def test_conflicting_dois_with_same_bibliography_remain_distinct(self):
        a=self.upsert(paper('doi:10.1234/a','10.1234/a',sid='W1'))
        b=self.upsert(paper('doi:10.1234/b','10.1234/b',source='crossref',sid='B'))
        self.assertNotEqual(a,b);self.assertEqual(self.roots(),2)
        alias=self.c.execute("SELECT ambiguous,paper_id FROM public.research_paper_aliases WHERE session_id=%s AND alias LIKE 'bibmeta:%%'",[self.session]).fetchone()
        self.assertEqual(alias,(True,None))
        c=self.upsert(paper('openalex:W3',sid='W3'));self.assertNotIn(c,[a,b]);self.assertEqual(self.roots(),3)
    def test_strong_source_alias_doi_conflict_rolls_back(self):
        a=self.upsert(paper('doi:10.1234/a','10.1234/a',sid='W1'))
        self.conflict(lambda:self.upsert(paper('doi:10.1234/b','10.1234/b',sid='W1')),message='IDENTITY_CONFLICT')
        self.assertEqual(self.roots(),1);self.assertEqual(self.c.execute('SELECT metadata->>\'doi\' FROM public.research_session_papers WHERE id=%s',[a]).fetchone()[0],'10.1234/a')
    def test_hash_collision_requires_full_equality_and_stays_ambiguous(self):
        a=self.upsert(paper('openalex:W1',sid='W1'))
        diff=paper('crossref:X',source='crossref',sid='X',title='Different paper')
        aliases=rpc(self.c,'research_record_aliases',diff);alias=next(x for x in aliases if x.startswith('bibmeta:'))
        # Inject a lookup collision. It must never establish identity by itself.
        self.admin.execute('INSERT INTO public.research_paper_aliases(session_id,alias,paper_id) VALUES(%s,%s,%s)',[self.session,alias,a])
        b=self.upsert(diff);self.assertNotEqual(a,b)
        diff2=paper('openalex:W2',sid='W2',title='Different paper');c=self.upsert(diff2)
        self.assertNotIn(c,[a,b]);self.assertEqual(self.roots(),3)
        self.assertEqual(self.c.execute('SELECT ambiguous,paper_id FROM public.research_paper_aliases WHERE session_id=%s AND alias=%s',[self.session,alias]).fetchone(),(True,None))
    def test_legitimate_bridge_preserves_lifecycle_and_redirects(self):
        a=self.upsert(paper('openalex:W1',sid='W1',given=''))
        b=self.upsert(paper('doi:10.1234/a','10.1234/a',source='crossref',sid='10.1234/a',given=''))
        self.assertNotEqual(a,b)
        for target,actions in [(a,['view','save','reject']),(b,['view','cite'])]:
            for action in actions:
                v=self.c.execute('SELECT row_version FROM public.research_session_papers WHERE id=%s',[target]).fetchone()[0]
                rpc(self.c,'update_research_paper',self.actor,self.session,target,v,action,1,'context','explicit reject')
        p=paper('doi:10.1234/a','10.1234/a',sid='W1',given='')
        winner=self.upsert(p);self.assertEqual(winner,a);self.assertEqual(self.roots(),1)
        row=self.c.execute('SELECT saved_at,cited_at,rejected_at,first_viewed_at,last_viewed_at,rejection_reason,canonical_key FROM public.research_session_papers WHERE id=%s',[winner]).fetchone()
        self.assertTrue(all(x is not None for x in row[:5]));self.assertEqual(row[5],'explicit reject');self.assertEqual(row[6],'doi:10.1234/a')
        self.assertEqual(rpc(self.c,'research_resolve_paper',self.session,b),winner)
    def test_author_order_and_full_names_required_for_fallback(self):
        a=paper('openalex:W1',sid='W1');a['authors'].append({'given':'John','family':'Jones'})
        x=self.upsert(a)
        b=paper('crossref:X',source='crossref',sid='X');b['authors']=list(reversed(a['authors']))
        self.assertNotEqual(x,self.upsert(b))
        c=paper('crossref:Y',source='crossref',sid='Y');c['authors']=[{'given':'J','family':'Smith'},{'given':'John','family':'Jones'}]
        self.assertNotEqual(x,self.upsert(c))
    def test_ambiguous_phase1_bib_alias_stays_disconnected(self):
        a=self.upsert(paper('bib:collision','10.1234/a',sid='W1'))
        b=self.upsert(paper('bib:collision','10.1234/b',source='crossref',sid='B'))
        c=self.upsert(paper('bib:collision',sid='W3'))
        self.assertEqual(len({a,b,c}),3)
        self.assertEqual(self.c.execute("SELECT ambiguous,paper_id FROM public.research_paper_aliases WHERE session_id=%s AND alias='bib:collision'",[self.session]).fetchone(),(True,None))
    def test_old_callback_completion_cannot_overwrite_new_attempt(self):
        self.expire();new=self.retry()
        results={'openalex':{'status':'error'},'crossref':{'status':'error'}}
        self.conflict(lambda:rpc(self.c,'complete_research_pull',self.actor,self.session,self.pid,uuid.UUID(self.pull['attemptToken']),1,digest(results),results,[]),message='STALE_ATTEMPT')
        self.assertEqual(self.c.execute('SELECT attempt_token::text FROM public.research_retrievals WHERE id=%s',[self.pid]).fetchone()[0],new['attemptToken'])
    def test_retry_conflict_does_not_persist_expiry(self):
        self.expire()
        self.conflict(lambda:self.retry(version=99),message='STALE_RECEIPT')
        self.assertEqual(self.c.execute('SELECT execution_status,receipt_version FROM public.research_retrievals WHERE id=%s',[self.pid]).fetchone(),('running',1))
        self.assertEqual(self.retry()['disposition'],'execute')
    def test_all_rpc_execution_client_denied_and_service_granted(self):
        rows=self.admin.execute("SELECT p.oid::regprocedure::text,p.prosecdef,p.proconfig,has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('service_role',p.oid,'EXECUTE') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'").fetchall()
        self.assertEqual(len(rows),29)
        for signature,definer,config,auth,anon,service in rows:
            self.assertFalse(definer,signature);self.assertIn('search_path=pg_catalog',config);self.assertFalse(auth,signature);self.assertFalse(anon,signature);self.assertTrue(service,signature)
        self.assertEqual(self.admin.execute("SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)").fetchone()[0],0)
    def test_deterministic_takeover_waits_for_session_lock(self):
        self.expire();gate=conn();barrier=threading.Barrier(3)
        def run():
            with conn() as c:
                barrier.wait()
                try:return self.retry(c=c)['disposition']
                except psycopg.Error as e:return e.sqlstate
        with ThreadPoolExecutor(max_workers=2) as pool:
            with gate.transaction():
                rpc(gate,'research_lock_session',self.actor,self.session)
                futures=[pool.submit(run) for _ in range(2)];barrier.wait()
                until=time.monotonic()+2
                while time.monotonic()<until:
                    waiting=self.admin.execute("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT public.retry_failed_research_sources%'").fetchone()[0]
                    if waiting==2:break
                    time.sleep(.01)
                self.assertEqual(waiting,2)
                self.assertTrue(all(not f.done() for f in futures))
            answers=[f.result() for f in futures]
        gate.close();self.assertEqual(sorted(answers),['PT409','execute'])
    def test_context_bound_continuation(self):
        cont={'version':1,'query':'other','yearFrom':None,'yearTo':None,'sources':{'openalex':{},'crossref':{}}}
        self.conflict(lambda:rpc(self.c,'research_check_continuation',cont,'learning',None,None,{'openalex':1,'crossref':1}),code='PT400')
    def test_no_authenticated_or_anon_access(self):
        for role in ['authenticated','anon']:
            for table in ['research_sessions','research_retrievals','research_session_papers','research_paper_aliases']:
                for privilege in ['SELECT','INSERT','UPDATE','DELETE']:
                    self.assertFalse(self.admin.execute('SELECT has_table_privilege(%s,%s,%s)',[role,'public.'+table,privilege]).fetchone()[0])
            with conn(role) as c:
                self.conflict(lambda:c.execute('SELECT * FROM public.research_sessions'),code='42501')
                self.conflict(lambda:rpc(c,'research_require_actor',self.actor),code='42501')
    def test_service_ownership_and_deletion(self):
        self.conflict(lambda:rpc(self.c,'research_lock_session',uuid.uuid4(),self.session),code='PT404')
        a=self.upsert(paper('openalex:W1',sid='W1'))
        version=self.c.execute('SELECT row_version FROM public.research_sessions WHERE id=%s',[self.session]).fetchone()[0]
        rpc(self.c,'delete_research_session',self.actor,self.session,version)
        self.conflict(lambda:self.retry(),code='PT404')
        self.assertEqual(self.admin.execute('SELECT count(*) FROM public.research_session_papers WHERE id=%s',[a]).fetchone()[0],0)

if __name__=='__main__':unittest.main(verbosity=2)
