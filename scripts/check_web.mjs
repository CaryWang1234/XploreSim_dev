// Static guard for the shipped web bundle: encoding, and HTML tag balance.
//
// Two accidents this repo has actually had: a file written through a shell redirect came out as
// mojibake, and an edit to index.html deleted the opening tags of the neighbouring <details> block.
// Both rendered fine in a local browser until the text was unreadable or a section vanished, so they
// are checked here rather than eyeballed. Run with `npm run check` before publishing.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HTML = 'web/index.html';
const JS_DIR = 'web/js';

// Byte sequences that only appear when UTF-8 text has been read as latin-1 and re-encoded, or when a
// decoder substituted U+FFFD. A real page never contains them.
const MOJIBAKE = ['â€', 'Ã©', 'Ã¨', 'Ã¼', 'å­', 'æµ', 'ä¸­', 'çš„', 'è¡¨', '\ufeff'];
const REPLACEMENT = Buffer.from([0xef, 0xbf, 0xbd]);

// The tags index.html uses as containers. Void elements are excluded because they have no close tag.
const TAGS = ['details', 'summary', 'div', 'p', 'label', 'select', 'option', 'strong', 'span', 'em', 'table', 'tbody', 'thead', 'tr', 'td', 'th', 'ul', 'li', 'section', 'aside', 'main', 'header', 'footer', 'button', 'h1', 'h2', 'h3'];

let bad = 0;
const fail = (msg) => { console.log('FAIL ' + msg); bad++; };

const files = [HTML, 'web/styles.css', 'package.json', '.gitignore']
  .map((f) => path.join(ROOT, f))
  .concat(fs.readdirSync(path.join(ROOT, JS_DIR)).filter((f) => f.endsWith('.js')).map((f) => path.join(ROOT, JS_DIR, f)));

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (!fs.existsSync(f)) { fail(`${rel} is listed but missing`); continue; }
  const buf = fs.readFileSync(f);
  const txt = buf.toString('utf8');
  if (buf.includes(REPLACEMENT)) fail(`${rel} contains U+FFFD, the decoder replacement character`);
  for (const pat of MOJIBAKE) if (txt.includes(pat)) fail(`${rel} contains ${JSON.stringify(pat)}: mojibake`);
}

const html = fs.readFileSync(path.join(ROOT, HTML), 'utf8');
for (const tag of TAGS) {
  const open = (html.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) || []).length;
  const close = (html.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  if (open !== close) fail(`<${tag}> opens ${open} times and closes ${close} times`);
}

// A module that does not parse renders as a blank page with an EMPTY console in the in-app browser,
// which is how one unescaped apostrophe in a UI string hid for a whole session. `node --check` is the
// parser, so it is asked directly instead of pattern-matching quotes.
for (const name of fs.readdirSync(path.join(ROOT, JS_DIR))) {
  if (!name.endsWith('.js')) continue;
  const out = spawnSync(process.execPath, ['--check', path.join(ROOT, JS_DIR, name)], { encoding: 'utf8' });
  if (out.status !== 0) fail(`${name} does not parse: ${(out.stderr || '').split('\n').slice(0, 3).join(' / ')}`);
}
for (const name of fs.readdirSync(path.join(ROOT, 'scripts'))) {
  if (!name.endsWith('.mjs')) continue;
  const out = spawnSync(process.execPath, ['--check', path.join(ROOT, 'scripts', name)], { encoding: 'utf8' });
  if (out.status !== 0) fail(`scripts/${name} does not parse: ${(out.stderr || '').split('\n').slice(0, 3).join(' / ')}`);
}

// The batch cap is three things that have to say the same number: the constant the clamp uses, the `max` each
// input publishes, and the ceiling the page tells the reader about. A mismatch is an input that silently rounds
// a request down, or a hint that promises more than the run will do.
{
  const ui = fs.readFileSync(path.join(ROOT, JS_DIR, 'ui.js'), 'utf8');
  const cap = Number(ui.match(/const MAX_BATCH = (\d+)/)?.[1]);
  if (!Number.isInteger(cap)) fail('ui.js has no `const MAX_BATCH = <n>` for the batch cap');
  else {
    for (const id of ['inp-mcmatches', 'inp-replay-match']) {
      const m = html.match(new RegExp('id="' + id + '"[^>]*\\bmax="(\\d+)"'));
      if (!m) fail(`#${id} has no max attribute for the batch cap ${cap}`);
      else if (Number(m[1]) !== cap) fail(`#${id} publishes max=${m[1]} while ui.js clamps a batch at ${cap}`);
    }
  }
}

// #129: the single-MATCH flow ledger and the live RP ladder are one contract across four files. engine.js has
// to hand the counters over, worker.js has to let them through to the page (it whitelists the recorded fields,
// so a new one that is not listed is silently dropped in the browser and works everywhere else), ui.js has to
// read them and ask for the elements, and index.html has to carry those elements. The RP rungs are checked
// against rules.js because the line under the scoreboard has to be the same test the final score is graded with.
{
  const eng = fs.readFileSync(path.join(ROOT, JS_DIR, 'engine.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, JS_DIR, 'ui.js'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT, JS_DIR, 'worker.js'), 'utf8');
  const rules = fs.readFileSync(path.join(ROOT, JS_DIR, 'rules.js'), 'utf8');
  for (const key of ['collectFrom', 'fuelReclaimed', 'modeSec', 'modeIn']) {
    if (!eng.includes(`${key}:`)) fail(`engine.js no longer declares ${key} on the per-ROBOT record`);
    if (!ui.includes(key)) fail(`ui.js never reads ${key}, so its column prints nothing`);
  }
  if (!eng.includes('hubReturned')) fail('engine.js no longer counts what each HUB hands back onto the FIELD');
  if (!worker.includes('hubReturned')) fail('worker.js does not pass hubReturned through, so the reclaim column is empty in the browser');
  for (const id of ['flow-table', 'flow-note', 'rp-live-red', 'rp-live-blue']) {
    if (!html.includes(`id="${id}"`)) fail(`#${id} is not in index.html — the ledger has nowhere to render`);
    if (!ui.includes(`'${id}'`)) fail(`ui.js never asks for #${id}`);
  }
  for (const rung of ['energized', 'supercharged', 'traversal']) {
    if (!rules.includes(`${rung}:`)) fail(`rules.js no longer names the ${rung} threshold the live RP ladder reads`);
    if (!ui.includes(`th.${rung}`)) fail(`ui.js's RP ladder never compares against ${rung}`);
  }
}

// #130: the single-MATCH charts are drawn by hand on a canvas, so the contract is three things: the derivations
// live in a module that touches no DOM (that is what lets `runtime.test.mjs` run them against a real record),
// ui.js imports and calls them, and index.html carries the four canvases and the line under them. The last
// check keeps this true: a chart library would arrive as a <script src>, and the page has to load with no
// network at all.
{
  const ui = fs.readFileSync(path.join(ROOT, JS_DIR, 'ui.js'), 'utf8');
  const data = fs.readFileSync(path.join(ROOT, JS_DIR, 'chartdata.js'), 'utf8');
  if (!ui.includes("from './chartdata.js'")) fail('ui.js does not import chartdata.js, so the charts have no data source');
  for (const fn of ['scoreSeries', 'periodBands', 'windowBands', 'modeBands', 'sourceRows', 'robotRows']) {
    if (!data.includes(`export function ${fn}`)) fail(`chartdata.js no longer exports ${fn}, which ui.js draws`);
    if (!ui.includes(`${fn}(`)) fail(`ui.js never calls ${fn}`);
  }
  if (data.includes('document.') || data.includes('window.')) fail('chartdata.js touches the DOM, so runtime.test.mjs cannot run the derivations');
  // The legend line names the modes, so the import list has to carry the list too. Missing it is not a broken
  // caption: the throw lands in the middle of renderResult, and everything after the charts stops rendering.
  const chartImport = ui.match(/import \{([^}]*)\} from '\.\/chartdata\.js'/);
  if (!chartImport || !chartImport[1].includes('MODE_ORDER')) fail('ui.js does not import MODE_ORDER from chartdata.js, which its chart legend names');
  for (const id of ['chart-trend', 'chart-window', 'chart-roles', 'chart-sources', 'chart-shape-note']) {
    if (!html.includes(`id="${id}"`)) fail(`#${id} is not in index.html — that chart has nowhere to draw`);
    if (!ui.includes(`'${id}'`)) fail(`ui.js never asks for #${id}`);
  }
  for (const lib of ['cdn.', 'jsdelivr', 'unpkg', 'chart.js', 'echarts']) {
    if (html.includes(lib) || ui.includes(lib)) fail(`the page references ${lib}: charts are hand-drawn and must load offline`);
  }
}

console.log(bad === 0 ? `OK: ${files.length} files are UTF-8 clean and index.html tags balance.` : `${bad} problem(s).`);
process.exit(bad === 0 ? 0 : 1);
