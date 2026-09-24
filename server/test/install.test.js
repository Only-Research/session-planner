const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The installer is run against a throwaway home folder every time, so it can
// never touch the real ~/.claude or ~/.codex of whoever runs these tests. The
// planner's default store is pointed at a folder that must never be created.
const APP = fs.realpathSync(path.resolve(__dirname, '../..'));
const INSTALLER = path.join(APP, 'install.command');
const SKILL = path.join(APP, 'skills', 'session-plan');

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-planner-install-')));
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const realRuns = path.join(root, 'real-runs');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  const install = ({ script = INSTALLER, args = [], pathPrefix } = {}) => {
    const env = { ...process.env, HOME: home, TMPDIR: tmp, SESSION_PLANNER_RUNS: realRuns };
    if (pathPrefix) env.PATH = `${pathPrefix}:${process.env.PATH}`;
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 60000, env });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  // Every start check must have run on a throwaway store and left it stopped.
  const checksStopped = (app = APP) => {
    assert.equal(fs.existsSync(realRuns), false, 'the installer touched the default sessions folder');
    const checks = fs.readdirSync(tmp).filter(n => n.startsWith('session-planner-check.'));
    assert.ok(checks.length > 0, 'no start check ran in the throwaway temp folder');
    for (const name of checks) {
      const status = spawnSync(process.execPath, [path.join(app, 'server', 'planner.js'), 'status', '--runs', path.join(tmp, name)], { encoding: 'utf8' });
      assert.equal(JSON.parse(status.stdout).running, false, `start check left a planner running in ${name}`);
    }
  };
  const fakeNode = script => {
    const bin = path.join(root, 'fake-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return bin;
  };
  return { root, home, install, checksStopped, fakeNode, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the installer connects both agents, proves the planner starts, and is safe to rerun', () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.home, '.claude'));
    fs.mkdirSync(path.join(box.home, '.codex'));
    const first = box.install();
    assert.equal(first.status, 0, first.output);
    assert.match(first.output, /Planner starts: ok/);
    assert.match(first.output, /Session Planner is ready/);
    for (const agent of ['.claude', '.codex']) {
      assert.equal(fs.readlinkSync(path.join(box.home, agent, 'skills', 'session-plan')), SKILL);
    }
    const again = box.install();
    assert.equal(again.status, 0, again.output);
    assert.match(again.output, /Claude Code: already connected/);
    assert.match(again.output, /Codex: already connected/);
    box.checksStopped();
  } finally { box.done(); }
});

test('the installer leaves another live copy alone unless asked, repairs dead links, and never replaces a real folder', () => {
  const box = sandbox();
  try {
    const claudeLink = path.join(box.home, '.claude', 'skills', 'session-plan');
    const codexSkills = path.join(box.home, '.codex', 'skills');
    const other = path.join(box.root, 'other-copy', 'skills', 'session-plan');
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(path.dirname(claudeLink), { recursive: true });
    fs.mkdirSync(path.join(codexSkills, 'session-plan'), { recursive: true });
    fs.writeFileSync(path.join(codexSkills, 'session-plan', 'SKILL.md'), 'someone else\n');
    fs.symlinkSync(other, claudeLink);

    const kept = box.install();
    assert.equal(kept.status, 1, kept.output);
    assert.equal(fs.readlinkSync(claudeLink), other);
    assert.match(kept.output, /Claude Code: already connected to another copy of Session Planner/);
    assert.match(kept.output, /--replace/);
    assert.match(kept.output, /Codex: not connected/);
    assert.equal(fs.readFileSync(path.join(codexSkills, 'session-plan', 'SKILL.md'), 'utf8'), 'someone else\n');

    const replaced = box.install({ args: ['--replace'] });
    assert.equal(fs.readlinkSync(claudeLink), SKILL, replaced.output);
    assert.match(replaced.output, /Claude Code: connected \(the link pointed to /);
    assert.equal(fs.readFileSync(path.join(codexSkills, 'session-plan', 'SKILL.md'), 'utf8'), 'someone else\n');

    fs.unlinkSync(claudeLink);
    fs.symlinkSync(path.join(box.root, 'gone', 'skills', 'session-plan'), claudeLink);
    const repaired = box.install();
    assert.equal(fs.readlinkSync(claudeLink), SKILL, repaired.output);
    box.checksStopped();
  } finally { box.done(); }
});

test('the installer reports a link it could not create instead of claiming success', () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.home, '.claude'));
    fs.writeFileSync(path.join(box.home, '.claude', 'skills'), 'a file where the folder should be\n');
    const result = box.install();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Claude Code: couldn't create the link/);
    assert.doesNotMatch(result.output, /Session Planner is ready/);
  } finally { box.done(); }
});

test('the installer explains a missing agent and creates nothing for it', () => {
  const box = sandbox();
  try {
    const result = box.install();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /Install Claude Code or Codex/);
    assert.equal(fs.existsSync(path.join(box.home, '.claude')), false);
    assert.equal(fs.existsSync(path.join(box.home, '.codex')), false);
  } finally { box.done(); }
});

test('the installer stops before changing anything when Node.js is too old or broken', () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.home, '.claude'));
    const old = box.install({ pathPrefix: box.fakeNode('echo 18') });
    assert.equal(old.status, 1, old.output);
    assert.match(old.output, /needs Node\.js 20 or newer/);
    const broken = box.install({ pathPrefix: box.fakeNode('exit 1') });
    assert.equal(broken.status, 1, broken.output);
    assert.match(broken.output, /didn't report its version/);
    assert.equal(fs.existsSync(path.join(box.home, '.claude', 'skills')), false);
  } finally { box.done(); }
});

test('the installer is not fooled by a warning Node prints on every run', () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.home, '.claude'));
    const noisy = box.fakeNode(`echo "Warning: Ignoring extra certs from missing.pem" >&2\nexec "${process.execPath}" "$@"`);
    const result = box.install({ pathPrefix: noisy });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Code packages: ok/);
    box.checksStopped();
  } finally { box.done(); }
});

test('the installer stops before changing anything when the code packages are missing', () => {
  const box = sandbox();
  try {
    // A copy of the app's shape without server/node_modules.
    const copy = path.join(box.root, 'app');
    fs.mkdirSync(path.join(copy, 'server'), { recursive: true });
    fs.cpSync(SKILL, path.join(copy, 'skills', 'session-plan'), { recursive: true });
    fs.copyFileSync(INSTALLER, path.join(copy, 'install.command'));
    fs.copyFileSync(path.join(APP, 'server', 'package.json'), path.join(copy, 'server', 'package.json'));
    fs.mkdirSync(path.join(box.home, '.claude'));
    const result = box.install({ script: path.join(copy, 'install.command') });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /npm ci --ignore-scripts/);
    assert.equal(fs.existsSync(path.join(box.home, '.claude', 'skills')), false);
  } finally { box.done(); }
});

test('the installer works from a folder whose path contains spaces', () => {
  const box = sandbox();
  try {
    const copy = path.join(box.root, 'My Apps', 'session planner');
    for (const part of ['install.command', 'server', 'skills', 'viewer', 'templates']) {
      fs.cpSync(path.join(APP, part), path.join(copy, part), { recursive: true, filter: src => !src.includes(`${path.sep}test${path.sep}`) });
    }
    fs.mkdirSync(path.join(box.home, '.claude'));
    const result = box.install({ script: path.join(copy, 'install.command') });
    assert.equal(result.status, 0, result.output);
    assert.equal(fs.readlinkSync(path.join(box.home, '.claude', 'skills', 'session-plan')), path.join(copy, 'skills', 'session-plan'));
    box.checksStopped(copy);
  } finally { box.done(); }
});
