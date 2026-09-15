import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureWorkspace, cleanupWorkplace, commandRunner } from './workplace-guardian.mjs';

function temp(t) { const directory = mkdtempSync(path.join(os.tmpdir(), 'sonata-guardian-')); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory; }

test('captures binary stdout and stderr separately without corrupting archive bytes', async t => {
  const directory = temp(t);
  const execute = commandRunner(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0,1,255])); process.stderr.write("diagnostic only");']);
  await execute([], { stdoutFile: path.join(directory, 'archive'), stderrFile: path.join(directory, 'stderr') });
  assert.deepEqual(readFileSync(path.join(directory, 'archive')), Buffer.from([0,1,255]));
  assert.equal(readFileSync(path.join(directory, 'stderr'), 'utf8'), 'diagnostic only');
});

test('kills an overflowing stream and retains only a bounded partial capture', async t => {
  const directory = temp(t);
  const execute = commandRunner(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048)); setInterval(()=>{},1000);']);
  const before = Date.now();
  await assert.rejects(execute([], { stdoutFile: path.join(directory, 'archive.partial'), stdoutLimit: 1024 }), /capture limit/);
  assert.ok(Date.now() - before < 3000);
  assert.ok(statSync(path.join(directory, 'archive.partial')).size <= 1024);
});

test('kills a command that never completes at the external deadline', async () => {
  const execute = commandRunner(process.execPath, ['-e', 'setInterval(()=>{},1000);']);
  await assert.rejects(execute([], { timeoutMs: 30 }), /SIGKILL/);
});

test('freezes the workspace before capture and publishes only a completed archive', async t => {
  const directory = temp(t), calls = [];
  const execute = async (args, options) => {
    calls.push(args[0]);
    if (args[0] === 'inspect') return { stdout: JSON.stringify(args[2].includes('Mounts') ? [{ Type: 'volume', Name: 'workspace-volume', Destination: '/workspace' }] : { Running: true, Paused: false }) };
    if (args[0] === 'cp') writeFileSync(options.stdoutFile, 'raw tar bytes');
    return { stdout: '' };
  };
  const archived = await captureWorkspace({ containers: { agent: 'agent' }, volumes: { workspace: 'workspace-volume' } }, directory, execute);
  assert.deepEqual(calls, ['inspect', 'inspect', 'pause', 'cp']);
  assert.equal(archived.status, 'captured');
  assert.equal(readFileSync(path.join(directory, 'agent-workspace.tar'), 'utf8'), 'raw tar bytes');
  assert.equal(existsSync(path.join(directory, 'agent-workspace.tar.partial')), false);
});

test('discloses a lost temporary workspace and still removes every container and network', async t => {
  const directory = temp(t), calls = [];
  writeFileSync(path.join(directory, 'workplace.json'), JSON.stringify({ agentStarted: true,
    containers: { apps: { slack: 'slack' }, agent: 'agent', gateway: 'gateway', operator: 'operator' },
    networks: { backend: 'backend', agent: 'agentnet', operator: 'operatornet' }, volumes: { workspace: 'workspace-volume' } }));
  const execute = async args => {
    calls.push(args);
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ Running: false, Paused: false }) };
    return { stdout: '' };
  };
  const result = await cleanupWorkplace(directory, 'provider failed', execute);
  assert.equal(result.status, 'cleanup-failed');
  assert.equal(result.workspaceArchive.status, 'incomplete');
  assert.match(result.cleanupErrors[0], /temporary workspace cannot be captured/);
  assert.equal(calls.some(args => args[0] === 'cp'), false);
  assert.deepEqual(calls.filter(args => args[0] === 'rm').map(args => args[2]).sort(), ['agent', 'gateway', 'operator', 'slack']);
  assert.deepEqual(calls.filter(args => args[0] === 'network').map(args => args[2]).sort(), ['agentnet', 'backend', 'operatornet']);
  assert.deepEqual(calls.filter(args => args[0] === 'volume').map(args => args[2]), ['workspace-volume']);
});

test('actual Docker pause preserves tmpfs and archives symlinks as data', { skip: process.env.SONATA_GUARDIAN_LIVE !== '1' }, async t => {
  const directory = temp(t), name = `sonata-guardian-probe-${randomUUID().slice(0, 8)}`;
  const images = JSON.parse(readFileSync(path.resolve('integrations/runtime/../../.context/runtime/images.json'), 'utf8'));
  const execute = commandRunner();
  const volume = `${name}-workspace`;
  try {
    await execute(['volume', 'create', '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=256m,uid=1000,gid=1000,nosuid,nodev,noexec', volume]);
    await execute(['run', '--detach', '--name', name, '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '0.5', '--pids-limit', '32',
      '--mount', `type=volume,source=${volume},target=/workspace,volume-nocopy`, '--entrypoint', 'sleep', images.agent.id, 'infinity']);
    await execute(['exec', name, 'node', '-e', 'require("fs").writeFileSync("/workspace/notes.txt","retained agent notes"); require("fs").symlinkSync("/private/evaluator/criteria", "/workspace/untrusted-link");']);
    const result = await captureWorkspace({ containers: { agent: name }, volumes: { workspace: volume } }, directory, execute);
    assert.equal(result.status, 'captured');
    assert.equal(JSON.parse((await execute(['inspect', '--format', '{{json .State}}', name])).stdout).Paused, true);
    const archive = readFileSync(path.join(directory, 'agent-workspace.tar'));
    assert.ok(archive.includes(Buffer.from('retained agent notes')));
    assert.ok(archive.includes(Buffer.from('/private/evaluator/criteria')));
    assert.equal(readFileSync(path.join(directory, 'agent-workspace-capture.stderr.log'), 'utf8'), '');
  } finally { await execute(['rm', '--force', name]).catch(() => undefined); await execute(['volume', 'rm', volume]).catch(() => undefined); }
});
