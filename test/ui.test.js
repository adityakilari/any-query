// Loads the built single-file page in jsdom and clicks through every view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildHtml } from '../scripts/build.mjs';

test('the app opens a sample and renders every tab without errors', async () => {
  const html = (await buildHtml()).replace(/<link[^>]+fonts[^>]*>/g, '');
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/', beforeParse(w) { w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = () => {}; w.addEventListener('error', (e) => errors.push(e.message)); } });
  const { document } = dom.window;
  const click = (sel) => { const el = document.querySelector(sel); assert.ok(el, sel); el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); };
  assert.equal(document.querySelectorAll('.sample').length, 9);
  click('[data-sample="1"]');
  assert.equal(document.getElementById('home').hidden, true);
  assert.equal(document.getElementById('result').hidden, false);
  assert.match(document.getElementById('view-explain').textContent, /Step by step/);
  for (const v of ['flow', 'columns', 'review', 'sql', 'export']) {
    click(`.tabs [data-view="${v}"]`);
    assert.equal(document.getElementById(`view-${v}`).hidden, false, v);
  }
  click('.tabs [data-view="review"]');
  assert.ok(document.querySelectorAll('.finding').length >= 6);
  click('[data-sev-filter="high"]');
  assert.ok([...document.querySelectorAll('.finding')].every((f) => f.dataset.sev === 'high'));
  click('.tabs [data-view="flow"]');
  click('[data-node]');
  assert.match(document.getElementById('flow-card').textContent, /Columns used|Step/);
  // multi-statement sample shows a statement picker
  click('#new');
  click('[data-sample="5"]');
  assert.equal(document.querySelectorAll('#stmts button').length, 3);
  click('[data-stmt="2"]');
  assert.match(document.getElementById('r-lede').textContent, /Deletes the orders/);
  // pasted SQL via the URL fragment (used by Any Schema's "Open in Any Query")
  const dom2 = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: `https://example.test/#sql=${encodeURIComponent('SELECT 1 AS one')}`, beforeParse(w) { w.scrollTo = () => {}; } });
  assert.equal(dom2.window.document.getElementById('result').hidden, false);
  assert.deepEqual(errors, []);
});

test('works where the address bar cannot be changed (sandboxed previews)', async () => {
  const html = (await buildHtml()).replace(/<link[^>]+fonts[^>]*>/g, '');
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/', beforeParse(w) {
    w.scrollTo = () => {};
    w.history.replaceState = () => { throw new w.DOMException('blocked', 'SecurityError'); };
    w.addEventListener('error', (e) => errors.push(e.message));
  } });
  const { document } = dom.window;
  const click = (sel) => document.querySelector(sel).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  click('[data-sample="0"]');
  for (const v of ['flow', 'review', 'explain']) click(`.tabs [data-view="${v}"]`);
  assert.equal(document.getElementById('view-explain').hidden, false);
  assert.deepEqual(errors, []);
});
