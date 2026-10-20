// Claude Restore: every few seconds, note which Claude Code sessions are running
// in this window's terminals. When the window comes back after a close or crash,
// offer to reopen them, each in its own terminal, with `claude --resume <id>`.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const core = require('./core');

const POLL_MS = 4000;
const MISSES_BEFORE_DROP = 2;   // gone for two polls in a row = exited on purpose
const RESTORE_GRACE_POLLS = 15; // a restored session gets ~60s to show up before we give up on it

let stateFile;
let pending = [];          // sessions from last time, not running anywhere yet
const tracked = new Map(); // sessionId -> { session, misses }
let lastSaved = '';
let statusItem;
let log;
let timer;
let polling = false;

function activate(context) {
  log = vscode.window.createOutputChannel('Claude Restore');
  context.subscriptions.push(log);
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'claudeRestore.restore';
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeRestore.restore', () => restore(pending)),
    vscode.commands.registerCommand('claudeRestore.pick', pick),
    vscode.commands.registerCommand('claudeRestore.dismiss', dismiss),
    vscode.commands.registerCommand('claudeRestore.showLog', () => log.show()),
  );

  // Windows with no folder all share one global store, so they'd restore each
  // other's sessions. Only track windows that have their own workspace storage.
  if (!context.storageUri) {
    log.appendLine('no folder open in this window: not tracking');
    return;
  }
  const dir = context.storageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  stateFile = path.join(dir, 'sessions.json');

  const live = core.liveSessionIds();
  pending = core.readState(stateFile)
    .filter(s => !live.has(s.sessionId) && core.hasTranscript(s.sessionId))
    .map(s => ({ ...s, title: core.sessionTitle(s.sessionId) || s.title || '' }));
  log.appendLine(`state: ${stateFile}`);
  log.appendLine(`from last time: ${pending.map(label).join(', ') || 'nothing to restore'}`);
  updateStatus();
  if (pending.length) offer();

  poll();
  timer = setInterval(poll, POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

// Claude derives a name like "myapp-a3" for every session; it says nothing
// about the chat. A name the user gave wins, then the title from the transcript.
function label(s) {
  const given = s.nameSource && s.nameSource !== 'derived' ? s.name : '';
  return given || s.title || s.name || s.sessionId.slice(0, 8);
}

// Claude writes its own live tab title ("✳ <title>") as soon as it resumes. Where
// tabs show that (`${sequence}` in terminal.integrated.tabs.title), a fixed name
// would cover it up for good. Elsewhere the tab would only say "claude": pin the title.
function tabName(s) {
  const template = vscode.workspace.getConfiguration('terminal.integrated.tabs').get('title') || '';
  return template.includes('${sequence}') ? undefined : label(s);
}

function someLabels(sessions, max = 3) {
  const names = sessions.slice(0, max).map(label).join(', ');
  return sessions.length > max ? `${names} and ${sessions.length - max} more` : names;
}

async function offer() {
  const n = pending.length;
  const names = someLabels(pending);
  const choice = await vscode.window.showInformationMessage(
    `${n} Claude session${n === 1 ? ' was' : 's were'} open in this window: ${names}`,
    'Restore', 'Choose…', 'Dismiss');
  if (choice === 'Restore') restore(pending);
  else if (choice === 'Choose…') pick();
  else if (choice === 'Dismiss') dismiss();
}

async function pick() {
  if (!pending.length) return vscode.window.showInformationMessage('No Claude sessions to restore.');
  const items = pending.map(s => ({ label: label(s), description: s.cwd, picked: true, session: s }));
  const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Restore Claude sessions' });
  if (chosen) restore(chosen.map(i => i.session));
}

function dismiss() {
  pending = [];
  save();
  updateStatus();
}

function restore(sessions) {
  const live = core.liveSessionIds();
  let last;
  let front;
  for (const s of sessions) {
    const cmd = core.resumeCommand(s.sessionId);
    if (!cmd || live.has(s.sessionId)) continue; // already running somewhere: a second copy would fork it
    if (!fs.existsSync(s.cwd)) {
      vscode.window.showWarningMessage(`Can't restore ${label(s)}: its folder is gone (${s.cwd}).`);
      continue;
    }
    last = vscode.window.createTerminal({ name: tabName(s), cwd: s.cwd });
    last.sendText(cmd);
    if (s.active) front = last;
    const session = { ...s, order: vscode.window.terminals.indexOf(last), active: false };
    tracked.set(s.sessionId, { session, misses: -RESTORE_GRACE_POLLS });
    log.appendLine(`restored ${label(s)}: ${cmd} (in ${s.cwd})`);
  }
  (front || last)?.show();
  const ids = new Set(sessions.map(s => s.sessionId));
  pending = pending.filter(s => !ids.has(s.sessionId));
  save();
  updateStatus();
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const shells = new Set();
    const tabIndex = new Map(); // shell pid -> position in the tab row
    for (const [i, t] of vscode.window.terminals.entries()) {
      const pid = await t.processId;
      if (pid) { shells.add(pid); tabIndex.set(pid, i); }
    }
    const frontPid = vscode.window.activeTerminal && await vscode.window.activeTerminal.processId;
    const running = core.sessionsUnderShells(shells, core.readRegistry(), await core.processParents());
    const seen = new Set();
    for (const s of running) {
      seen.add(s.sessionId);
      if (!tracked.has(s.sessionId)) log.appendLine(`watching ${label(s)} (${s.sessionId})`);
      const session = {
        sessionId: s.sessionId, name: s.name, nameSource: s.nameSource, cwd: s.cwd, startedAt: s.startedAt,
        order: tabIndex.get(s.shellPid), active: s.shellPid === frontPid,
      };
      tracked.set(s.sessionId, { session, misses: 0 });
    }
    const windowUp = core.windowIsUp(shells);
    for (const [id, t] of tracked) {
      if (seen.has(id) || !windowUp) continue;
      if (++t.misses >= MISSES_BEFORE_DROP) {
        tracked.delete(id);
        log.appendLine(`stopped watching ${label(t.session)}: it exited`);
      }
    }
    // Restored by hand in another window, or by us: no longer something to offer.
    const before = pending.length;
    const live = core.liveSessionIds();
    pending = pending.filter(s => !live.has(s.sessionId));
    if (pending.length !== before) updateStatus();
    save();
  } catch (err) {
    log.appendLine(`poll failed: ${err && err.stack || err}`);
  } finally {
    polling = false;
  }
}

function save() {
  if (!stateFile) return;
  // Tab order, which `vscode.window.terminals` keeps (tabs dragged into a new order
  // aren't visible to extensions). Sessions still waiting from last time keep theirs, after.
  const current = [...tracked.values()].map(t => t.session).sort((a, b) => a.order - b.order);
  const ids = new Set(current.map(s => s.sessionId));
  const sessions = [...current, ...pending.filter(s => !ids.has(s.sessionId))];
  const json = JSON.stringify(sessions);
  if (json === lastSaved) return;
  core.writeState(stateFile, sessions);
  lastSaved = json;
}

function updateStatus() {
  if (!pending.length) return statusItem.hide();
  statusItem.text = `$(history) Restore Claude (${pending.length})`;
  statusItem.tooltip = `Reopen: ${someLabels(pending, 5)}`;
  statusItem.show();
}

function deactivate() {
  clearInterval(timer);
}

module.exports = { activate, deactivate };
