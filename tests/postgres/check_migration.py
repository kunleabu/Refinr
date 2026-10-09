from pathlib import Path
import re
from pglast import parse_sql, parse_plpgsql, ast
s=(Path(__file__).resolve().parents[2] / 'supabase/migrations/20261007000100_research_sessions_phase2a.sql').read_text()
nodes=parse_sql(s);definitions=parse_plpgsql(s)
tables=[n.stmt for n in nodes if isinstance(n.stmt,ast.CreateStmt)]
funcs=[n.stmt for n in nodes if isinstance(n.stmt,ast.CreateFunctionStmt)]
checks={
 'four tables':len(tables)==4,
 'only research table definitions':all(t.relation.relname in {'research_sessions','research_retrievals','research_session_papers','research_paper_aliases'} for t in tables),
 '29 functions':len(funcs)==29,
 '30 function and DO definitions':len(definitions)==30,
 'every function invoker and fixed search path':s.count('SECURITY INVOKER SET search_path = pg_catalog')==29,
 'no definer or replacement or extension':all(v not in s for v in ['SECURITY DEFINER','CREATE OR REPLACE','CREATE EXTENSION']),
 'RLS enabled on all four tables':s.count('ENABLE ROW LEVEL SECURITY')==4,
 'no client table policies':not any(isinstance(n.stmt,ast.CreatePolicyStmt) for n in nodes),
 'no authenticated SELECT grant':not re.search(r'GRANT\s+SELECT\s+ON[^;]+TO\s+authenticated',s,re.I),
 'all function signatures granted exactly once':s.count('::regprocedure')==29,
 'PUBLIC and client EXECUTE revoked':'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated' in s,
 'service-only function EXECUTE':'GRANT EXECUTE ON FUNCTION %s TO service_role' in s,
 'same 45-second initial and retry lease':s.count("clock_timestamp()+interval '45 seconds'")==2,
 'qualified continuation keys':s.count('array_agg(keys.key ORDER BY keys.key)')==2,
}
retry=s.split('CREATE FUNCTION public.retry_failed_research_sources(',1)[1].split('END $$;',1)[0]
checks['receipt version compared before expiry']=retry.index('IF p_expected_receipt_version')<retry.index('PERFORM public.research_expire_attempt')
checks['retry always owner/session locked']=retry.index('research_lock_session')<retry.index('SELECT * INTO r')
for name,passed in checks.items():
 print(('PASS ' if passed else 'FAIL ')+name)
assert all(checks.values())
print(f'{len(checks)} static checks passed; {len(nodes)} SQL statements / {len(definitions)} PLpgSQL/SQL/DO definitions parsed')
