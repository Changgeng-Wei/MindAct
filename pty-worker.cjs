// PTY worker — runs under Node.js (not Bun) so node-pty native addon works.
// Communicates via newline-delimited JSON on stdin/stdout.
'use strict';

function sendLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let pty;
try {
  pty = require('./node_modules/node-pty');
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const rebuildCmd = 'cd node_modules/node-pty && npx --yes node-gyp@10 rebuild';
  const hint =
    process.platform === 'linux'
      ? `From repo root: ${rebuildCmd}  (e.g. apt install build-essential)`
      : `From repo root: ${rebuildCmd}`;
  sendLine({
    type: 'data',
    data:
      '\r\n\x1b[31m[MindAct] Terminal backend (node-pty) failed to load.\x1b[0m\r\n' +
      '\x1b[90m' + msg + '\x1b[0m\r\n' +
      '\x1b[90m' + hint + '\x1b[0m\r\n\r\n',
  });
  sendLine({ type: 'exit' });
  process.exit(1);
}

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const cwd = process.env.PTY_CWD || process.cwd();

// Read a value from the root .env file.
function readDotEnvValue(key) {
  try {
    const envFile = path.join(__dirname, '.env');
    for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      if (trimmed.slice(0, eq).trim() === key) {
        return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
  return undefined;
}

function ensureSpawnHelperExecutable() {
  try {
    const helper = path.join(
      __dirname,
      'node_modules',
      'node-pty',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    );
    if (fs.existsSync(helper)) {
      const st = fs.statSync(helper);
      // Add owner/group/other execute bits if missing.
      if ((st.mode & 0o111) === 0) {
        fs.chmodSync(helper, st.mode | 0o755);
      }
    }
  } catch {}
}
ensureSpawnHelperExecutable();

function isExecutable(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const { execSync } = require('child_process');
  const looksLikePath =
    /[\\/]/.test(cmd) ||
    (process.platform === 'win32' && /\.(exe|cmd|bat)$/i.test(cmd));
  try {
    if (looksLikePath) {
      return fs.existsSync(cmd);
    }
    if (process.platform === 'win32') {
      execSync(`where ${JSON.stringify(cmd)}`, { stdio: 'ignore' });
    } else {
      execSync(`which ${JSON.stringify(cmd)} 2>/dev/null || test -x ${JSON.stringify(cmd)}`, { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

function whereWin(cmd) {
  if (process.platform !== 'win32') return '';
  const { execSync } = require('child_process');
  try {
    const out = execSync(`where ${JSON.stringify(cmd)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out || '').trim();
  } catch {
    return '';
  }
}

// Resolve the CLI binary — prefer project-local physmind, then CLAUDE_BIN env
function findClaude() {
  const os = require('os');
  const isWin = process.platform === 'win32';
  const bin = isWin ? 'physmind.exe' : 'physmind';
  const candidates = [
    // Explicit override via env
    process.env.CLAUDE_BIN,
    // setup.ps1 copies physmind.exe here
    isWin ? path.join(os.homedir(), '.cargo', 'bin', 'physmind.exe') : null,
    // setup.sh links physmind here
    isWin ? null : '/usr/local/bin/physmind',
    // Project-local build
    path.join(__dirname, 'cli', 'rust', 'target', 'release', bin),
    // x64 cross-compiled target (ARM64 Windows)
    isWin ? path.join(__dirname, 'cli', 'rust', 'target', 'x86_64-pc-windows-msvc', 'release', 'physmind.exe') : null,
    // Dev machine claw-code checkout
    path.join(os.homedir(), 'claw-code', 'rust', 'target', 'release', bin),
    // System PATH
    'physmind',
  ].filter(Boolean);
  for (const c of candidates) {
    if (!c) continue;
    if (isExecutable(c)) return c;
  }
  return null;
}

function resolveEntryCommand() {
  const claudeBin = findClaude();
  if (claudeBin) {
    return { command: claudeBin, args: [] };
  }
  return null;
}

// Read DashScope API key from global credentials file or .env.
function readDashScopeKey() {
  // Try global credentials file first (~/.config/physmind/credentials)
  try {
    const credFile = path.join(require('os').homedir(), '.config', 'physmind', 'credentials');
    if (fs.existsSync(credFile)) {
      for (const line of fs.readFileSync(credFile, 'utf-8').split('\n')) {
        const m = line.match(/^KPLR_KEY="?([^"]+)"?/);
        if (m) return m[1].trim();
      }
    }
  } catch {}
  // Fall back to .env
  return process.env.DASHSCOPE_API_KEY || readDotEnvValue('DASHSCOPE_API_KEY') || null;
}

// Build the environment for claw: forward all provider config from .env and
// global credentials to the spawned Rust CLI process.
function buildClawEnv() {
  const env = { ...process.env };
  // Forward all provider config keys from env var or .env
  const keys = [
    'DASHSCOPE_BASE_URL', 'DASHSCOPE_API_KEY', 'DASHSCOPE_MODEL',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
    'OPENAI_BASE_URL',    'OPENAI_API_KEY',    'OPENAI_MODEL',
    'XAI_BASE_URL',       'XAI_API_KEY',       'XAI_MODEL',
    'ACTIVE_PROVIDER',
  ];
  for (const key of keys) {
    const val = (process.env[key] && process.env[key].trim()) || readDotEnvValue(key);
    if (val) {
      env[key] = val;
    }
  }
  // Backward compat: map KPLR_KEY to DASHSCOPE_API_KEY if needed
  if (!env.DASHSCOPE_API_KEY && env.KPLR_KEY) {
    env.DASHSCOPE_API_KEY = env.KPLR_KEY;
  }
  // Point claw at a MindAct-specific config dir so ~/.claw/credentials.json
  // (which may contain a saved Anthropic OAuth token) is never read.
  env.CLAW_CONFIG_HOME = path.join(require('os').homedir(), '.config', 'physmind', 'claw');
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

// Check if any provider API key is configured.
function hasAnyProviderKey() {
  const envKeys = [
    'DASHSCOPE_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
  ];
  for (const key of envKeys) {
    if (process.env[key] || readDotEnvValue(key)) return true;
  }
  // Also check global credentials file
  return !!readDashScopeKey();
}

let term = null;

function send(msg) {
  const line = JSON.stringify(msg) + '\n';
  process.stdout.write(line);
  if (process.stdout.writableNeedDrain) process.stdout.uncork();
}

function spawnTerm(cols, rows) {
  if (term) { try { term.kill(); } catch {} }

  if (!hasAnyProviderKey()) {
    send({
      type: 'data',
      data: '\r\n\x1b[31m[PhysMind] No API Key found.\x1b[0m\r\n' +
            '\x1b[90mSet at least one API key in the .env file to get started.\x1b[0m\r\n\r\n',
    });
    return;
  }

  const entry = resolveEntryCommand();
  if (!entry) {
    send({
      type: 'data',
      data:
        '\r\n\x1b[31m[MindAct] Claude CLI not found.\x1b[0m\r\n' +
        '\x1b[90mBuild/install physmind.exe (recommended): run .\\setup.ps1, or build from source: cd .\\cli\\rust && cargo build --release -p rusty-claude-cli\x1b[0m\r\n' +
        '\x1b[90mOr set CLAUDE_BIN to an absolute path of the CLI binary.\x1b[0m\r\n\r\n',
    });
    send({ type: 'exit' });
    process.exit(1);
    return;
  }

  try {
    term = pty.spawn(entry.command, entry.args, {
      name: 'xterm-256color',
      cols: cols || 120,
      rows: rows || 40,
      cwd,
      env: buildClawEnv(),
    });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    const whereOut = typeof entry.command === 'string' ? whereWin(entry.command) : '';
    send({
      type: 'data',
      data:
        '\r\n\x1b[31m[MindAct] PTY unavailable. Claude terminal cannot start.\x1b[0m\r\n' +
        `\x1b[90m${msg}\x1b[0m\r\n` +
        (whereOut ? `\x1b[90mwhere ${entry.command}:\r\n${whereOut}\x1b[0m\r\n` : '') +
        '\x1b[90mFix: ensure physmind.exe is on PATH (usually %USERPROFILE%\\.cargo\\bin) or set CLAUDE_BIN to the full path.\x1b[0m\r\n\r\n',
    });
    send({ type: 'exit' });
    process.exit(1);
  }

  term.onData((data) => {
    // Replace internal credential error messages with user-friendly text.
    const filtered = data
      .replace(/missing DashScope credentials[^\r\n]*/g, 'No API Key found. Set DASHSCOPE_API_KEY in the .env file.')
      .replace(/missing Anthropic credentials[^\r\n]*/g, 'No API Key found. Set ANTHROPIC_API_KEY in the .env file.')
      .replace(/export ANTHROPIC_AUTH_TOKEN[^\r\n]*/g, '')
      .replace(/export ANTHROPIC_API_KEY[^\r\n]*/g, '')
      .replace(/ANTHROPIC_AUTH_TOKEN[^\r\n]*/g, '')
      .replace(/export DASHSCOPE_API_KEY[^\r\n]*/g, '')
      .replace(/DASHSCOPE_API_KEY[^\r\n]*/g, '');
    send({ type: 'data', data: filtered });
  });
  term.onExit(() => {
    send({ type: 'exit' });
    process.exit(0);
  });
}

// Start terminal immediately
spawnTerm(120, 40);

// Read commands from stdin
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (!term) return;
    if (msg.type === 'input') {
      term.write(msg.data);
    } else if (msg.type === 'resize') {
      term.resize(msg.cols, msg.rows);
    }
  } catch {}
});

rl.on('close', () => {
  if (term) try { term.kill(); } catch {}
  process.exit(0);
});
