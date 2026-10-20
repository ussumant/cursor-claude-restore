// Plain-node half of Claude Restore: everything that reads Claude Code's files
// and the process table. No vscode import, so it can be tested from a shell.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const REGISTRY_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const MAX_HOPS = 8;
const TITLE_CHUNK = 256 * 1024;
const TITLE_MAX_SCAN = 16 * 1024 * 1024;
const TITLE_LINE_MAX = 64 * 1024;

// Claude Code keeps one <pid>.json per running session and deletes it when the
// process exits, so this is "what is running right now".
function readRegistry() {
  let files = [];
  try { files = fs.readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json')); } catch { return []; }
  const entries = [];
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, f), 'utf8'));
      if (e.pid && e.sessionId && isAlive(e.pid)) entries.push(e);
    } catch { /* half-written or unreadable: skip this poll */ }
  }
  return entries;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// While Cursor quits, the extension host can outlive the terminals by several
// seconds. If no terminal shell in the window is alive, the window is going down:
// count nothing as "exited", or the record would be wiped right before it's needed.
function windowIsUp(shellPids) {
  return [...shellPids].some(isAlive);
}

function liveSessionIds() {
  return new Set(readRegistry().map(e => e.sessionId));
}

function processParents() {
  return new Promise(resolve => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], (err, stdout) => {
      const parents = new Map();
      if (!err) for (const line of stdout.split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid) parents.set(pid, ppid);
      }
      resolve(parents);
    });
  });
}

// Interactive sessions whose process sits under one of the given shell pids.
// Skipped: background (--bg) sessions, which outlive the window on their own, and
// any Claude started by another Claude (a `claude -p` a session ran, a subagent).
function sessionsUnderShells(shellPids, registry, parents) {
  const claudePids = new Set(registry.map(e => e.pid));
  const found = [];
  for (const e of registry) {
    if (e.kind && e.kind !== 'interactive') continue;
    let p = shellPids.has(e.pid) ? e.pid : parents.get(e.pid);
    let nested = false;
    for (let hops = 0; p > 1 && hops < MAX_HOPS && !shellPids.has(p); hops++) {
      if (claudePids.has(p)) { nested = true; break; }
      p = parents.get(p);
    }
    if (nested || !shellPids.has(p)) continue;
    found.push({
      sessionId: e.sessionId, name: e.name || '', nameSource: e.nameSource || '',
      cwd: e.cwd, startedAt: e.startedAt || 0, shellPid: p,
    });
  }
  return found;
}

function transcriptPath(sessionId) {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// A session that never got a message has no transcript, and --resume would fail on it.
function hasTranscript(sessionId) {
  return transcriptPath(sessionId) !== null;
}

// The title the /resume picker shows: a /rename title ("custom-title") or the one
// Claude wrote itself ("ai-title"). Claude re-appends it as the chat goes on, so the
// newest copy sits near the end. Transcripts run past 100MB, so read backwards in
// chunks and stop at the first one found.
function sessionTitle(sessionId) {
  const file = transcriptPath(sessionId);
  if (!file) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let end = fs.fstatSync(fd).size;
    const stop = Math.max(0, end - TITLE_MAX_SCAN);
    let carry = Buffer.alloc(0); // start of the line the previous chunk cut off
    while (end > stop) {
      const start = Math.max(stop, end - TITLE_CHUNK);
      const chunk = Buffer.alloc(end - start);
      fs.readSync(fd, chunk, 0, chunk.length, start);
      let buf = Buffer.concat([chunk, carry]);
      if (start > 0) {
        const nl = buf.indexOf(10);
        carry = nl < 0 ? buf : buf.subarray(0, nl);
        buf = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1);
        // A title line is short. A longer one is a big tool result: don't rebuild it.
        if (carry.length > TITLE_LINE_MAX) carry = Buffer.alloc(0);
      }
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('-title"')) continue;
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        const title = e.type === 'custom-title' ? e.customTitle : e.type === 'ai-title' ? e.aiTitle : '';
        if (typeof title === 'string' && title.trim()) return title.replace(/\s+/g, ' ').trim();
      }
      end = start;
    }
  } catch { /* unreadable: fall back to the session's name */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return '';
}

function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch { return []; }
}

function writeState(file, sessions) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), sessions }, null, 2));
  fs.renameSync(tmp, file);
}

// The id goes into a shell, so only ever send something shaped like a session id.
function resumeCommand(sessionId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;
  return `claude --resume ${sessionId}`;
}

module.exports = {
  readRegistry, liveSessionIds, windowIsUp, processParents, sessionsUnderShells,
  hasTranscript, sessionTitle, readState, writeState, resumeCommand,
};
