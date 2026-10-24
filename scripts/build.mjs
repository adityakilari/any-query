// Builds dist/index.html: one self-contained page (CSS + JS inlined) that works offline and from
// file://. GitHub Pages serves this file. Fonts load from Google Fonts when online and fall back
// to system fonts otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildHtml() {
  const result = await build({
    entryPoints: [path.join(root, 'src/ui/app.js')],
    bundle: true, format: 'iife', minify: true, write: false, target: ['es2020'], legalComments: 'none',
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(root, 'src/ui/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  return html
    .replace('<link rel="stylesheet" href="src/ui/styles.css">', () => `<style>\n${css}\n</style>`)
    .replace('<script src="app.js"></script>', () => `<script>\n${js}\n</script>`); // functions: the code contains $ patterns
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const html = await buildHtml();
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/index.html'), html);
  fs.copyFileSync(path.join(root, 'dist/index.html'), path.join(root, 'dist/any-query.html'));
  console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB (also copied to dist/any-query.html)`);
}
