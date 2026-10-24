import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/core/tokenize.js';
import { parse } from '../src/core/parse.js';
import { detectDialect } from '../src/core/dialect.js';
import { read } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';

test('tokenizer handles dialect quoting and comments', () => {
  const t = tokenize(`SELECT "a b", \`c\`, [d e], 'it''s', q'[x'y]', $$body$$, E'\\n', x::int, p.id(+), :name, @v, $1 -- c\n/* b */`);
  const kinds = t.map((x) => x.t);
  assert.deepEqual(t.filter((x) => x.t === 'qid').map((x) => x.name), ['a b', 'c', 'd e']);
  assert.deepEqual(t.filter((x) => x.t === 'str').map((x) => x.value), ["it's", "x'y", 'body', '\n']);
  assert.ok(t.some((x) => x.t === 'op' && x.v === '::'));
  assert.ok(t.some((x) => x.t === 'op' && x.outer));
  assert.deepEqual(t.filter((x) => x.t === 'param').map((x) => x.v), [':name', '@v', '$1']);
  assert.equal(kinds.filter((k) => k === 'comment').length, 2);
});

test('GO and / batch separators split statements', () => {
  assert.equal(parse('SELECT 1\nGO\nSELECT 2\n/\nSELECT 3').statements.length, 3);
});

test('parses every statement kind', () => {
  const r = parse(`
    WITH x AS (SELECT 1 AS a) SELECT * FROM x;
    INSERT INTO t (a) SELECT a FROM u;
    UPDATE t SET a = 1 WHERE b = 2;
    DELETE FROM t WHERE a IS NULL;
    MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.v = s.v WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id);
    CREATE OR REPLACE VIEW v AS SELECT a FROM t;
    CREATE TABLE z (id int);
    BEGIN x := 1; END;
  `);
  assert.deepEqual(r.statements.map((s) => s.type), ['query', 'insert', 'update', 'delete', 'merge', 'create', 'ddl', 'routine']);
  assert.deepEqual(r.notes, []);
});

test('reads dialect-specific syntax without notes', () => {
  const qs = [
    "SELECT TOP 10 a.Name FROM dbo.A a WITH (NOLOCK) CROSS APPLY (SELECT TOP 1 * FROM B b WHERE b.AId = a.Id ORDER BY b.D DESC) x",
    "SELECT e.id FROM emp e, dept d WHERE e.dept_id = d.id(+) AND ROWNUM <= 5 CONNECT BY PRIOR e.id = e.mgr_id",
    "SELECT DISTINCT ON (c.id) c.id, o.data->>'sku' FROM c JOIN o ON o.cid = c.id WHERE o.t ILIKE '%x%' AND o.n = ANY(ARRAY[1,2]) ORDER BY c.id, o.ts DESC",
    "SELECT * EXCLUDE (a) FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY k ORDER BY ts DESC) = 1",
    "SELECT `x`.`y`, GROUP_CONCAT(z ORDER BY z SEPARATOR ',') FROM `db`.`x` GROUP BY 1 LIMIT 5, 10",
    "SELECT SAFE_CAST(a AS INT64), ARRAY_AGG(STRUCT(b, c)) FROM `p.d.t`, UNNEST(items) AS i",
    "SELECT EXTRACT(YEAR FROM d), SUBSTRING(s FROM 2 FOR 3), CAST(x AS DECIMAL(10,2)), INTERVAL '1 day', DATE '2024-01-01' FROM t",
    "SELECT a FROM t WHERE (a, b) IN (SELECT a, b FROM u) AND c BETWEEN 1 AND 2 AND d NOT LIKE 'x%' ESCAPE '!'",
    "SELECT COUNT(*) FILTER (WHERE x > 1), PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY y) FROM t GROUP BY ROLLUP (a, b)",
    "SELECT DATEADD(month, -3, GETDATE()), DATEDIFF(day, a, b), Total = SUM(x) FROM t GROUP BY a",
  ];
  for (const q of qs) {
    const r = parse(q);
    assert.equal(r.statements.length, 1, q);
    assert.deepEqual(r.notes, [], q);
  }
});

test('recovers from syntax it does not know and notes it', () => {
  const r = parse('SELECT a, b ~~> c FROM t WHERE x = 1; SELECT 2');
  assert.equal(r.statements.length, 2);
  assert.ok(r.notes.length >= 1);
});

test('dialect detection', () => {
  assert.equal(detectDialect(read('samples/inpatients-oracle.sql')).id, 'oracle');
  assert.equal(detectDialect(read('samples/pipeline-sqlserver.sql')).id, 'sqlserver');
  assert.equal(detectDialect(read('samples/housekeeping-mysql.sql')).id, 'mysql');
  assert.equal(detectDialect(read('samples/monthly-revenue-snowflake.sql')).id, 'snowflake');
  assert.equal(detectDialect(read('samples/top-customers-postgres.sql')).id, 'postgres');
  assert.equal(detectDialect("SELECT * FROM `proj.ds.tbl`").id, 'bigquery');
});

test('all samples parse with no notes', () => {
  const dir = new URL('../samples/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const r = parse(fs.readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(r.statements.length >= 1, f);
    assert.deepEqual(r.notes, [], f);
  }
  void path;
});
