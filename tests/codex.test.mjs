import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { codexArgs, runCodex, stopProcessTree, findCodex } from '../scripts/codex.mjs';
import { tempDir, cleanup } from './helpers.mjs';

const WS = '/tmp/workspace'; // codexArgs only checks absoluteness; POSIX form is fine on win32 for arg building
const RESULT = path.join(path.isAbsolute(WS) ? WS : '/tmp', 'result.md');

function argList(opts) {
  return codexArgs({ workspace: opts.workspace ?? WS, sandbox: opts.sandbox, threadId: opts.threadId, resultPath: opts.resultPath ?? RESULT });
}

test('codexArgs builds the new-task command in the exact order', () => {
  const args = argList({});
  assert.deepEqual(args, [
    'exec', '--sandbox', 'workspace-write', '-C', WS,
    '-c', 'approval_policy="never"', '--skip-git-repo-check', '--color', 'never',
    '--json', '--output-last-message', RESULT, '-',
  ]);
});

test('codexArgs inserts resume before --json and the thread id after the result path', () => {
  const threadId = '12345678-1234-4234-8234-123456789abc';
  const args = argList({ threadId });
  const resumeIdx = args.indexOf('resume');
  const jsonIdx = args.indexOf('--json');
  const outIdx = args.indexOf('--output-last-message');
  assert.ok(resumeIdx > 0 && resumeIdx < jsonIdx, 'resume must precede --json');
  assert.equal(args[outIdx + 1], RESULT, 'result path follows the flag');
  assert.equal(args[outIdx + 2], threadId, 'thread id follows the result path');
  assert.equal(args[args.length - 1], '-', 'prompt comes from stdin');
});

test('codexArgs validates sandbox, workspace and thread id', () => {
  assert.throws(() => argList({ sandbox: 'danger-full-access' }), e => e.code === 'INVALID_SANDBOX');
  assert.throws(() => argList({ workspace: 'relative/path' }), e => e.code === 'INVALID_WORKSPACE');
  assert.throws(() => argList({ threadId: 'not-a-uuid' }), e => e.code === 'INVALID_THREAD');
});

test('findCodex honours the env override', async () => {
  const previous = process.env.WECHAT_BRIDGE_CODEX_BIN;
  process.env.WECHAT_BRIDGE_CODEX_BIN = '/custom/codex';
  try { assert.equal(await findCodex(), '/custom/codex'); }
  finally { if (previous === undefined) delete process.env.WECHAT_BRIDGE_CODEX_BIN; else process.env.WECHAT_BRIDGE_CODEX_BIN = previous; }
});

const FAKE_CODEX = `
import fs from 'node:fs';
const args = process.argv.slice(2);
const i = args.indexOf('--output-last-message');
const resultPath = args[i + 1];
const resume = args.includes('resume');
let prompt = '';
for await (const c of process.stdin) prompt += c;
const threadId = resume ? args[i + 2] : 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STREAMED OUTPUT' } }) + '\\n');
fs.writeFileSync(resultPath, 'FILE OUTPUT | resume=' + resume + ' | thread=' + threadId + ' | ' + prompt.slice(0, 400));
`;

test('runCodex drives a fake codex: stdin prompt, event stream, result file', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const script = path.join(dir, 'fake-codex.mjs');
  await fs.writeFile(script, FAKE_CODEX);
  const resultPath = path.join(dir, 'result.md');
  const fakeSpawn = (exe, args, opts) => spawn(process.execPath, [script, ...args], opts);

  const run = runCodex({
    executable: 'codex', workspace: dir, sandbox: 'read-only', threadId: undefined,
    resultPath, prompt: '帮我改 README', timeoutMs: 20_000,
  }, fakeSpawn);
  const events = [];
  // onEvent is wired inside runCodex via opts — re-run with capture:
  const result = await run.done;
  assert.equal(result.status, 'completed');
  assert.equal(result.threadId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.ok(result.finalMessage.startsWith('FILE OUTPUT'), result.finalMessage);
  assert.ok(result.finalMessage.includes('帮我改 README'), 'stdin prompt must reach codex');
  assert.ok(!result.finalMessage.includes('resume=true'), 'new task must not resume');
  void events;
});

test('runCodex resume passes the thread id and flags resume in the fake', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const script = path.join(dir, 'fake-codex.mjs');
  await fs.writeFile(script, FAKE_CODEX);
  const resultPath = path.join(dir, 'result.md');
  const fakeSpawn = (exe, args, opts) => spawn(process.execPath, [script, ...args], opts);

  const run = runCodex({
    executable: 'codex', workspace: dir, sandbox: 'read-only',
    threadId: '11111111-2222-4333-8444-555555555555',
    resultPath, prompt: '继续', timeoutMs: 20_000,
  }, fakeSpawn);
  const result = await run.done;
  assert.equal(result.status, 'completed');
  assert.ok(result.finalMessage.includes('resume=true'), result.finalMessage);
  assert.ok(result.finalMessage.includes('thread=11111111-2222-4333-8444-555555555555'), 'thread id reaches the resume args');
});

test('runCodex stop() terminates a long-running child and reports stopped', async t => {
  const dir = await tempDir(); t.after(() => cleanup(dir));
  const script = path.join(dir, 'slow-codex.mjs');
  await fs.writeFile(script, `await new Promise(r => setTimeout(r, 30_000));`);
  const fakeSpawn = (exe, args, opts) => spawn(process.execPath, [script], opts);
  const run = runCodex({
    executable: 'codex', workspace: dir, sandbox: 'read-only',
    resultPath: path.join(dir, 'r.md'), prompt: 'x', timeoutMs: 30_000,
  }, fakeSpawn);
  setTimeout(() => run.stop(), 200);
  const result = await run.done;
  assert.equal(result.status, 'stopped');
});

test('stopProcessTree is a no-op for dead children', () => {
  stopProcessTree(null);
  stopProcessTree({ pid: undefined, exitCode: null, signalCode: null });
  stopProcessTree({ pid: 12345, exitCode: 0, signalCode: null });
  stopProcessTree({ pid: 12345, exitCode: null, signalCode: 'SIGTERM' });
});
