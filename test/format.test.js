import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { formatSql } from '../src/core/format.js';
import { tokenize } from '../src/core/tokenize.js';

const sig = (sql) => tokenize(sql).filter((t) => t.t !== 'eof').map((t) => (t.t === 'word' ? t.u : t.t === ';' && t.batch ? ';' : t.v.trim()));
const samples = fs.readdirSync(new URL('../samples/', import.meta.url)).filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8'));
const extra = [
  "select a,b from t where x between 1 and 2 and y=-1 or z in (select q from r) order by 1 desc",
  "with a as (select * from t), b as (select * from a) select case when x>1 then 'a' when x>2 then 'b' when x>3 then 'c' else 'd' end from b left outer join c on c.id=b.id cross join d",
  "select t.* , arr[1], x::numeric(10,2), -x, a - -1 from t /* keep */ -- end",
  'SELECT TOP 5 [Name] FROM dbo.[T] WITH (NOLOCK) WHERE id = @id\nGO\nSELECT 1',
  "update t set a = 1, b = 2 where c = 3; delete from u where v is null",
];

test('formatting changes only whitespace and keyword case', () => {
  for (const sql of [...samples, ...extra]) {
    const out = formatSql(sql);
    assert.deepEqual(sig(out), sig(sql), sql.slice(0, 80));
  }
});

test('formatting is stable', () => {
  for (const sql of [...samples, ...extra]) {
    const once = formatSql(sql);
    assert.equal(formatSql(once), once, sql.slice(0, 80));
  }
});

test('layout', () => {
  assert.equal(formatSql('select a, b from t join u on u.id = t.uid where x = 1 and y = 2'), 'SELECT a,\n       b\nFROM t\nJOIN u ON u.id = t.uid\nWHERE x = 1\n  AND y = 2\n');
  assert.match(formatSql("select * from t where d between '2020-01-01' and '2020-02-01'"), /BETWEEN '2020-01-01' AND '2020-02-01'/);
  assert.match(formatSql('select count(*) from t'), /COUNT\(\*\)/);
});
