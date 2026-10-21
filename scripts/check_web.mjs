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

// Table 6-5 prints a column per event tier, so "the bar" is only defined with the tier. This build
// shipped the bug: engine.js graded a DCMP batch against 240 while every caption beside the rate read
// the `.regional` field of the raw table, and `smoothUtility` hard-coded 100/360/50 so the tier the
// reader chose did not reach the objective either. The rule now is that `rules.js` is the only file
// allowed to name a column — everyone else goes through `rpBars(event)` — and the number the page
// prints is the one the engine graded against, which `mc.js` carries out of the MATCH rather than
// re-deriving. A literal column access outside rules.js is a caption that can drift again.
{
  for (const name of fs.readdirSync(path.join(ROOT, JS_DIR))) {
    if (!name.endsWith('.js') || name === 'rules.js') continue;
    const src = fs.readFileSync(path.join(ROOT, JS_DIR, name), 'utf8');
    const col = src.match(/\.(regional|districtChamp)\b/);
    if (col) fail(`${name} reads the Table 6-5 column ${col[0]} directly; take it from rpBars(event) so the caption cannot disagree with the grading`);
    if (/rpThreshold\s*\./.test(src)) fail(`${name} walks rpThreshold's own shape instead of calling rpBars()`);
  }
  const eng = fs.readFileSync(path.join(ROOT, JS_DIR, 'engine.js'), 'utf8');
  if (!eng.includes('rpBars(sc.event)')) fail('engine.js no longer grades against the scenario event, so a DCMP batch is graded on the regional column');
  const mcsrc = fs.readFileSync(path.join(ROOT, JS_DIR, 'mc.js'), 'utf8');
  if (!mcsrc.includes('a.rp.thresholds')) fail('mc.js no longer carries the graded bars out of the MATCH, so the page prints a re-derived number');
  const lg = fs.readFileSync(path.join(ROOT, JS_DIR, 'league.js'), 'utf8');
  if (!lg.includes('smoothUtility(res, aiSide, rpBars(sc.event))')) fail('league.js scores the objective without the event column, so the tier on the page does not reach the search');
  if (!/export const RP_TERMS/.test(lg)) fail('league.js no longer exports RP_TERMS, which scripts/rp.mjs audits');
  // The audit only has teeth if something runs it. A script nobody invokes is a claim, not a check.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!fs.existsSync(path.join(ROOT, 'scripts', 'rp.mjs'))) fail('scripts/rp.mjs is missing: which rung the objective weights is unmeasured');
  if (!pkg.scripts?.rp) fail('package.json has no `rp` script');
  if (!(pkg.scripts?.validate || '').includes('npm run rp')) fail('npm run validate does not run rp: the rung audit is not part of a release check');
}

// The autosave and the shareable link are two halves on purpose: statestore.js turns a setup into bytes
// and nothing else, so scripts/runtime.test.mjs can feed it a hostile link the way the browser would.
// That only holds while the codec touches no DOM and no storage, and the four selects the roster editor
// builds by hand have to keep agreeing with the lists the decoder accepts — a value the select cannot
// show is a card the reader cannot see, and a value the decoder does not know is a setup that silently
// loses a switch.
{
  const ui = fs.readFileSync(path.join(ROOT, JS_DIR, 'ui.js'), 'utf8');
  const store = fs.readFileSync(path.join(ROOT, JS_DIR, 'statestore.js'), 'utf8');
  if (/\b(document|window|localStorage)\./.test(store)) {
    fail('statestore.js touches the DOM or storage, so runtime.test.mjs cannot attack the decoder directly');
  }
  for (const fn of ['buildSetup', 'readSetup', 'encode', 'decode', 'toLink', 'packProfile', 'unpackProfile']) {
    if (!store.includes(`export function ${fn}`)) fail(`statestore.js no longer exports ${fn}`);
  }
  for (const fn of ['buildSetup', 'readSetup', 'encode', 'toLink', 'captureSetup', 'applySetup', 'restoreSetup', 'queueSave', 'copySetupLink']) {
    if (!ui.includes(fn)) fail(`ui.js never uses ${fn}, so half of the autosave or the link is dead`);
  }
  const arrayBody = (src, name) => {
    const start = src.indexOf(`const ${name} = [`);
    if (start < 0) return null;
    const end = src.indexOf('];', start);
    return end < 0 ? null : src.slice(start, end);
  };
  for (const [uiName, storeName] of [['CROSS_OPTIONS', 'cross'], ['PASS_OPTIONS', 'passMode'], ['PUSH_OPTIONS', 'pushMode'], ['FEED_OPTIONS', 'feedMode']]) {
    const fromUi = [...(arrayBody(ui, uiName) || '').matchAll(/v:\s*'([^']+)'/g)].map((m) => m[1]);
    // CHOICE is an object of arrays, so the entry is read by name rather than as a whole literal.
    const entry = store.match(new RegExp('\\n\\s+' + storeName + ':\\s*\\[([^\\]]*)\\]', 'm'));
    const fromStore = entry ? [...entry[1].matchAll(/'([^']+)'/g)].map((q) => q[1]) : [];
    if (!fromUi.length) fail(`ui.js's ${uiName} has no { v: '...' } values to compare`);
    if (!fromStore.length) fail(`statestore.js does not list the values ${uiName} offers under ${storeName}`);
    const missing = fromUi.filter((v) => !fromStore.includes(v));
    const extra = fromStore.filter((v) => !fromUi.includes(v));
    if (missing.length) fail(`statestore.js refuses ${storeName}: ${missing.join(', ')} that ${uiName} offers — a setup with it loses the switch`);
    if (extra.length) fail(`statestore.js accepts ${storeName}: ${extra.join(', ')} that ${uiName} cannot show`);
  }
  for (const id of ['btn-copy-link', 'btn-forget', 'setup-store']) {
    if (!html.includes(`id="${id}"`)) fail(`#${id} is not in index.html — that control does not exist`);
    if (!ui.includes(`'${id}'`)) fail(`ui.js never asks for #${id}`);
  }
}

// A declared AUTO crosses five files on the way to the page: the card holds it (`model.js`'s `auto`
// block), the engine turns it into a held load and a `stat.autoRoutine` (`engine.js`), the capability
// list carries it to the planner (`league.js` → `fastsim.js`), the result table prints it (`ui.js`), and
// the autosave has to keep it through bytes (`statestore.js`, which stores it as the flat `autoRoutine`
// because the card field is nested). Any one of those missing is a number that is silently not what the
// user typed — the exact class of bug where a feature works in Node and reads as zero in the browser.
{
  const eng = fs.readFileSync(path.join(ROOT, JS_DIR, 'engine.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, JS_DIR, 'ui.js'), 'utf8');
  const lg = fs.readFileSync(path.join(ROOT, JS_DIR, 'league.js'), 'utf8');
  const fs2 = fs.readFileSync(path.join(ROOT, JS_DIR, 'fastsim.js'), 'utf8');
  const store = fs.readFileSync(path.join(ROOT, JS_DIR, 'statestore.js'), 'utf8');
  if (!eng.includes('autoRoutine: null')) fail('engine.js no longer declares autoRoutine on the per-ROBOT stat');
  if (!eng.includes('rb.routine?.active')) fail('engine.js no longer gates the intake mouth and the shot accuracy on a live routine');
  if (!lg.includes('autoRoutine: rb.auto?.routineFuel ?? null')) fail('league.js capOf does not carry the declared AUTO to the planner');
  if (!fs2.includes('caps[i].autoRoutine')) fail('fastsim.js still models an AUTO the card has already measured');
  if (!ui.includes('data-k="autoRoutine"')) fail('ui.js has no AUTO FUEL input on the card');
  if (!ui.includes('s.autoRoutine')) fail('ui.js never reads autoRoutine, so the flow table prints an empty column');
  if (!store.includes("'autoRoutine'")) fail('statestore.js does not round-trip the declared AUTO: a link or reload silently un-declares it');
}

console.log(bad === 0 ? `OK: ${files.length} files are UTF-8 clean and index.html tags balance.` : `${bad} problem(s).`);
process.exit(bad === 0 ? 0 : 1);
