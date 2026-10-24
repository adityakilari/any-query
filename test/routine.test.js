// Functions, procedures and anonymous blocks in PL/pgSQL, PL/SQL and T-SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, read, schemas } from './helpers.js';

const flat = (items, out = []) => { for (const o of items || []) { out.push(o); if (o.branches) o.branches.forEach((b) => { out.push(b); flat(b.children, out); }); flat(o.children, out); } return out; };
const rulesOf = (st) => st.findings.map((f) => f.rule);

test('PL/pgSQL function: header, outline, embedded SQL and procedural checks', () => {
  const st = run(read('samples/import-documents-plpgsql.sql')).statements[0];
  assert.equal(st.type, 'routine');
  assert.equal(st.title, 'Function docs.import_documents');
  assert.deepEqual(st.routine.params.map((p) => p.name), ['p_payload']);
  assert.match(st.summary[0], /returns a set of `docs.documents` rows/);
  const items = flat(st.outline);
  const loop = st.outline.find((o) => o.loop);
  assert.match(loop.text, /For each row `v_item` of the elements of `v_items`/);
  assert.ok(items.some((o) => /`v_folder` = the part of `v_url` before the first “\/”/.test(o.text || '') || (o.items || []).some((i) => /`v_folder` = the part of `v_url` before the first “\/”/.test(i.text))));
  assert.ok(items.some((o) => /Looks up .* and stores it in `v_type_id`/.test(o.text || '')));
  assert.match(st.outline[st.outline.length - 1].text, /^Returns .*one of the values in `v_new_keys`/);
  const rules = rulesOf(st);
  for (const r of ['unassigned-variable', 'no-op-update', 'loop-invariant-sql', 'check-then-insert', 'unused-variable', 'always-true-condition']) assert.ok(rules.includes(r), r);
  // variables are not reported as unknown columns, RETURN QUERY d.* is not a SELECT * problem
  assert.ok(!rules.includes('unknown-alias') && !rules.includes('select-star') && !rules.includes('missing-join-condition'), rules.join());
  const unassigned = st.findings.find((f) => f.rule === 'unassigned-variable');
  assert.match(unassigned.title, /`v_parent_id`/);
  assert.equal(unassigned.line, 55);
  assert.deepEqual(st.tables.map((t) => [t.name, t.writes.join('/')]).sort(), [['docs.categories', ''], ['docs.document_types', ''], ['docs.documents', 'INSERT/UPDATE']]);
});

test('PL/pgSQL variables are not mistaken for columns, even with a schema loaded', () => {
  const sql = `CREATE FUNCTION f(p_email text) RETURNS bigint LANGUAGE plpgsql AS $$
  DECLARE v_id bigint;
  BEGIN
    SELECT id INTO v_id FROM customers WHERE email = p_email;
    RETURN v_id;
  END $$;`;
  const st = run(sql, { schema: schemas.shop() }).statements[0];
  assert.deepEqual(rulesOf(st).filter((r) => r.startsWith('unknown')), []);
  assert.ok(flat(st.outline).some((o) => /Looks up customer ID from `customers` where email is `p_email`, and stores it in `v_id`/.test(o.text || '')), JSON.stringify(st.outline.map((o) => o.text)));
});

test('Oracle PL/SQL procedure', () => {
  const st = run(read('samples/raise-salaries-plsql.sql')).statements[0];
  assert.equal(st.title, 'Procedure hr.raise_salaries');
  assert.deepEqual(st.routine.params.map((p) => [p.name, p.mode, p.default]), [['p_dept_id', 'IN', null], ['p_pct', 'IN', '5']]);
  const texts = flat(st.outline).map((o) => o.text || '').join('\n');
  assert.match(texts, /For each row `r` of the cursor `c_emps`/);
  assert.match(texts, /Stops with an error: “No employees in department”/);
  assert.match(texts, /Prints a message: “Budget exceeded”/);
  assert.match(texts, /If any error happens/);
  const rules = rulesOf(st);
  for (const r of ['dynamic-sql-concat', 'swallowed-error', 'unused-variable', 'loop-invariant-sql']) assert.ok(rules.includes(r), r);
});

test('SQL Server T-SQL procedure', () => {
  const st = run(read('samples/close-opportunities-tsql.sql')).statements[0];
  assert.equal(st.title, 'Procedure dbo.CloseStaleOpportunities');
  assert.deepEqual(st.routine.params.map((p) => [p.name, p.default]), [['@Days', '90'], ['@DryRun', '0']]);
  const texts = flat(st.outline).map((o) => o.text || '').join('\n');
  assert.match(texts, /If `@DryRun` is 1/);
  assert.match(texts, /Stops and returns/);
  assert.match(texts, /Tries the following/);
  assert.match(texts, /`@Closed` = the number of rows the last statement changed|Sets/);
  assert.match(texts, /Changes `Stage` to “Closed Lost” in `dbo.Opportunities`/);
  assert.ok(flat(st.outline).some((o) => (o.items || []).some((i) => /`@Cutoff` \(DATE\) = `@Days` days ago/.test(i.text))));
  const rules = rulesOf(st);
  assert.ok(rules.includes('dynamic-sql-concat'));
  assert.ok(rules.includes('select-into-many'));
  assert.equal(st.routine.parseError, null);
});

test('anonymous blocks, LANGUAGE sql functions and scripts', () => {
  const doBlock = run("DO $$ BEGIN UPDATE t SET a = 1 WHERE b = 2; RAISE NOTICE 'done'; END $$;").statements[0];
  assert.equal(doBlock.type, 'routine');
  assert.match(doBlock.outline[0].text, /Changes `a` to 1 in `t`/);
  const ora = run('DECLARE v NUMBER; BEGIN SELECT COUNT(*) INTO v FROM emp; IF v > 0 THEN DELETE FROM tmp; END IF; END;\n/\nSELECT 1 FROM dual', { dialect: 'oracle' });
  assert.deepEqual(ora.statements.map((s) => s.type), ['routine', 'query']);
  const sqlFn = run("CREATE FUNCTION active_count() RETURNS bigint LANGUAGE sql AS $$ SELECT COUNT(*) FROM users WHERE active $$;").statements[0];
  assert.equal(sqlFn.routine.sqlCount, 1);
  const script = run('DECLARE @n INT\nSELECT @n = COUNT(*) FROM dbo.T\nIF @n > 10\n  DELETE FROM dbo.T WHERE Old = 1\nPRINT @n', { dialect: 'sqlserver' }).statements[0];
  assert.equal(script.type, 'routine');
  assert.equal(script.routine.sqlCount, 2);
});

test('broken bodies degrade gracefully', () => {
  const st = run('CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN IF x THEN RETURN 1; $$;').statements[0];
  assert.equal(st.type, 'routine');
  assert.ok(st.routine.parseError);
  assert.match(st.summary.join(' '), /could not be read/);
});
