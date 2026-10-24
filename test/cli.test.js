import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { root } from './helpers.js';

const cli = (...args) => spawnSync(process.execPath, ['bin/any-query.js', ...args], { cwd: root, encoding: 'utf8' });

test('markdown output and CI exit codes', () => {
  const ok = cli('samples/top-customers-postgres.sql');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /## Step by step/);
  const bad = cli('samples/needs-review-postgres.sql', '--schema', 'samples/schemas/ecommerce-postgres.sql', '--fail-on', 'high');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /needs-review-postgres\.sql:15: high: .*\[not-in-null\]/);
  const json = JSON.parse(cli('samples/inpatients-oracle.sql', '-f', 'json').stdout);
  assert.equal(json.dialect.id, 'oracle');
  assert.match(cli('samples/inpatients-oracle.sql', '-f', 'sql').stdout, /^-- Yesterday/);
  assert.equal(cli('--nope').status, 2);
});
