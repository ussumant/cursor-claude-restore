// Headless check of extension.js with a stubbed vscode module and a fake
// ~/.claude (CLAUDE_CONFIG_DIR). Real processes stand in for shells and Claude:
// `sh -c 'sleep 300; sleep 300'` is the terminal shell, its first sleep is "claude",
// so killing "claude" leaves the shell alive, like a real terminal.
// Run: node test/harness.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-restore-test-'));
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
fs.mkdirSync(path.join(root, 'claude', 'sessions'), { recursive: true });
fs.mkdirSync(path.join(root, 'claude', 'projects', 'p'), { recursive: true });
const storage = path.join(root, 'storage');

const terminals = [];
const created = [];  // names of terminals the extension opened
const shown = [];    // names of terminals it brought to the front
const commands = {}; // command id -> handler, so the test can press Restore
let tabsTitle = '${process}'; // the user's terminal.integrated.tabs.title
const groups = []; // our own process groups, the only thing cleanup may kill
const vscode = {
  window: {
    terminals,
    createOutputChannel: () => ({ appendLine: l => console.log('   log:', l), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    activeTerminal: undefined,
    createTerminal: opts => { created.push(opts.name); return { sendText() {}, show() { shown.push(opts.name); } }; },
  },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
  workspace: { getConfiguration: () => ({ get: () => tabsTitle }) },
  StatusBarAlignment: { Left: 1 },
};
const origLoad = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? vscode : origLoad(req, ...rest));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stateNames = () => JSON.parse(fs.readFileSync(path.join(storage, 'sessions.json'), 'utf8')).sessions.map(s => s.name);

function fakeTerminalWithClaude(name, id) {
  const sh = spawn('sh', ['-c', 'sleep 300; sleep 300'], { stdio: 'ignore', detached: true });
  groups.push(sh.pid);
  return sleep(300).then(() => new Promise(resolve => {
    require('child_process').execFile('pgrep', ['-P', String(sh.pid)], (err, out) => {
      const claudePid = Number(out.trim().split('\n')[0]);
      fs.writeFileSync(path.join(root, 'claude', 'sessions', `${claudePid}.json`),
        JSON.stringify({ pid: claudePid, sessionId: id, cwd: root, kind: 'interactive', name, startedAt: Date.now() }));
      fs.writeFileSync(path.join(root, 'claude', 'projects', 'p', `${id}.jsonl`), '{}\n');
      resolve({ sh, claudePid, terminal: { processId: Promise.resolve(sh.pid) } });
    });
  }));
}

function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) process.exitCode = 1;
}

function titleCases() {
  const core = require('../core');
  const dir = path.join(root, 'claude', 'projects', 'q');
  fs.mkdirSync(dir, { recursive: true });
  const id = n => `33333333-3333-3333-3333-${String(n).padStart(12, '0')}`;
  const write = (n, lines) => fs.writeFileSync(path.join(dir, `${id(n)}.jsonl`), lines.join('\n') + '\n');
  const ai = t => JSON.stringify({ type: 'ai-title', aiTitle: t });
  const filler = (count, size) => Array.from({ length: count }, (_, i) => JSON.stringify({ type: 'assistant', i, text: 'x'.repeat(size) }));

  write(1, [ai('First'), ...filler(3, 10), ai('Newest')]);
  check('newest title wins', core.sessionTitle(id(1)) === 'Newest');
  write(2, [ai('Auto'), JSON.stringify({ type: 'custom-title', customTitle: 'Lane C · Launch week' })]);
  check('a /rename title is read', core.sessionTitle(id(2)) === 'Lane C · Launch week');
  write(3, [ai('Real'), JSON.stringify({ type: 'user', text: 'find {"type":"ai-title","aiTitle":"Decoy"}' })]);
  check('a message quoting a title line is not a title', core.sessionTitle(id(3)) === 'Real');
  write(4, [ai('Far back'), ...filler(400, 2000)]); // ~800KB after the title: several chunks
  check('title several chunks from the end', core.sessionTitle(id(4)) === 'Far back');
  write(5, [ai('Before a huge line'), ...filler(1, 3 * 1024 * 1024)]);
  check('file ending in one 3MB line', core.sessionTitle(id(5)) === 'Before a huge line');
  // Put the 256KB chunk edge at every byte of a short accented title line.
  const t = 'Café ✳ résumé — naïve';
  const line = ai(t);
  const len = Buffer.byteLength(line);
  const pad = Buffer.byteLength(JSON.stringify({ type: 'assistant', text: '' }));
  let rebuilt = true;
  for (let cut = 1; cut < len; cut++) {
    const after = 256 * 1024 - (len - cut) - 2; // bytes of filler so the edge lands `cut` bytes into the line
    write(6, [line, JSON.stringify({ type: 'assistant', text: 'x'.repeat(after - pad) })]);
    if (core.sessionTitle(id(6)) !== t) { rebuilt = false; console.log('   cut at byte', cut, '->', core.sessionTitle(id(6))); break; }
  }
  check('a title cut by the chunk edge at any byte is rebuilt', rebuilt);
  write(7, filler(3, 10));
  check('no title gives empty', core.sessionTitle(id(7)) === '');
  check('no transcript gives empty', core.sessionTitle(id(8)) === '');
}

(async () => {
  titleCases();
  const a = await fakeTerminalWithClaude('alpha', '11111111-1111-1111-1111-111111111111');
  const b = await fakeTerminalWithClaude('beta', '22222222-2222-2222-2222-222222222222');
  terminals.push(a.terminal, b.terminal);
  // Claude re-appends the session's title to its transcript as the chat goes on.
  fs.writeFileSync(path.join(root, 'claude', 'projects', 'p', '22222222-2222-2222-2222-222222222222.jsonl'), [
    { type: 'user', message: 'hi' },
    { type: 'ai-title', aiTitle: 'Old beta title', sessionId: '22222222-2222-2222-2222-222222222222' },
    { type: 'assistant', message: 'hello' },
    { type: 'ai-title', aiTitle: 'Fix the login bug', sessionId: '22222222-2222-2222-2222-222222222222' },
    { type: 'user', message: 'grep for "type":"ai-title" in the logs' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const ext = require('../extension');
  ext.activate({ storageUri: { fsPath: storage }, subscriptions: [] });
  await sleep(1500);
  check('both sessions recorded', stateNames().join() === 'alpha,beta');

  // 1. Claude exits inside a terminal that stays open: forget it after two polls.
  process.kill(a.claudePid);
  await sleep(10000);
  check('exited session dropped, other kept', stateNames().join() === 'beta');

  // 2. Window going down: every shell dies, terminals still listed. Keep the record.
  for (const pid of [b.claudePid, b.sh.pid, a.sh.pid]) { try { process.kill(pid); } catch {} }
  await sleep(10000);
  check('record survives a quit (shells dead)', stateNames().join() === 'beta');

  // 3. Terminals gone entirely: still keep it.
  terminals.length = 0;
  await sleep(10000);
  check('record survives zero terminals', stateNames().join() === 'beta');

  // 4. The window comes back. Tabs that show the process name get the session's title.
  ext.deactivate();
  const reopen = () => {
    delete require.cache[require.resolve('../extension')];
    const e = require('../extension');
    e.activate({ storageUri: { fsPath: storage }, subscriptions: [] });
    commands['claudeRestore.restore']();
    e.deactivate();
    const opened = created.splice(0);
    if (opened.length !== 1) return `opened ${opened.length} terminals`;
    return opened[0];
  };
  const pinned = reopen();
  check(`\${process} tabs: restored terminal named after the title (got ${JSON.stringify(pinned)})`, pinned === 'Fix the login bug');

  // 5. Tabs that show what the process writes: leave the name to Claude's live title.
  tabsTitle = '${sequence}';
  const left = reopen();
  check(`\${sequence} tabs: no fixed name over Claude's own title (got ${JSON.stringify(left)})`, left === undefined);

  // 6. Arrangement: tabs come back in the window's tab order (not start order), and
  // the tab that was in front is in front again.
  tabsTitle = '${process}';
  const storage2 = path.join(root, 'storage2');
  const c = await fakeTerminalWithClaude('gamma', '44444444-4444-4444-4444-444444444444');
  const d = await fakeTerminalWithClaude('delta', '55555555-5555-5555-5555-555555555555');
  const e = await fakeTerminalWithClaude('epsilon', '66666666-6666-6666-6666-666666666666');
  terminals.push(d.terminal, c.terminal, e.terminal); // he opened delta's tab first
  vscode.window.activeTerminal = c.terminal;
  delete require.cache[require.resolve('../extension')];
  const ext3 = require('../extension');
  ext3.activate({ storageUri: { fsPath: storage2 }, subscriptions: [] });
  await sleep(1500);
  const saved = JSON.parse(fs.readFileSync(path.join(storage2, 'sessions.json'), 'utf8')).sessions;
  check(`saved in tab order (got ${saved.map(s => s.name)})`, saved.map(s => s.name).join() === 'delta,gamma,epsilon');
  check('saved which tab was in front', saved.filter(s => s.active).map(s => s.name).join() === 'gamma');
  for (const p of [c.sh.pid, d.sh.pid, e.sh.pid]) { try { process.kill(-p); } catch {} }
  await sleep(500);
  ext3.deactivate();
  terminals.length = 0;
  vscode.window.activeTerminal = undefined;
  created.length = 0;
  shown.length = 0;
  delete require.cache[require.resolve('../extension')];
  const ext4 = require('../extension');
  ext4.activate({ storageUri: { fsPath: storage2 }, subscriptions: [] });
  commands['claudeRestore.restore']();
  ext4.deactivate();
  check(`restored in tab order (got ${created})`, created.join() === 'delta,gamma,epsilon');
  check(`the front tab is in front again (got ${shown})`, shown.join() === 'gamma');

  for (const g of groups) { try { process.kill(-g); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
  process.exit();
})();
