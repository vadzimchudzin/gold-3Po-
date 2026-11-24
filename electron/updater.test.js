import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isNewer, parseVersion, pickInstaller, releaseNotes, createUpdater } from './updater.js';

const release = (tag, assets = [{ name: 'GOLD-3Po Market Lab Setup 0.9.7.exe', browser_download_url: 'https://example.test/setup.exe', size: 1024 }]) => ({
  tag_name: tag, body: 'Что нового', assets
});

const respond = payload => async () => ({ ok: true, status: 200, json: async () => payload });
const listing = (...releases) => respond(releases);

test('versions compare numerically, part by part', () => {
  assert.equal(compareVersions('0.9.10', '0.9.9'), 1);
  assert.equal(compareVersions('v0.9.7', '0.9.7'), 0);
  assert.equal(compareVersions('0.9.7', '0.10.0'), -1);
  assert.equal(compareVersions('1.0', '0.99.99'), 1);
  assert.equal(isNewer('0.9.7', '0.9.6'), true);
  assert.equal(isNewer('0.9.6', '0.9.6'), false);
  assert.equal(parseVersion('не версия'), null);
});

test('only a Windows installer can be applied', () => {
  assert.equal(pickInstaller(release('0.9.7')).name, 'GOLD-3Po Market Lab Setup 0.9.7.exe');
  assert.equal(pickInstaller({ assets: [{ name: 'source.zip', browser_download_url: 'https://example.test/a.zip' }] }), null);
  assert.equal(pickInstaller({}), null);
});

test('release notes are trimmed so the panel cannot explode', () => {
  assert.equal(releaseNotes({ body: '  коротко  ' }), 'коротко');
  assert.equal(releaseNotes({ body: 'x'.repeat(900) }).length, 700);
});

test('a newer release is offered with its installer, an equal one is not', async () => {
  const newer = createUpdater({ repo: 'owner/repo', currentVersion: '0.9.6', fetchImpl: listing(release('v0.9.7')) });
  const offered = await newer.check();
  assert.equal(offered.state, 'available');
  assert.equal(offered.version, 'v0.9.7');
  assert.equal(offered.url, 'https://example.test/setup.exe');
  assert.equal(newer.pending().version, 'v0.9.7');

  const same = createUpdater({ repo: 'owner/repo', currentVersion: '0.9.7', fetchImpl: listing(release('v0.9.7')) });
  assert.equal((await same.check()).state, 'current');
  assert.equal(same.pending(), null, 'nothing is queued when there is nothing to install');
});

test('a release without an installer is never offered', async () => {
  const updater = createUpdater({ repo: 'owner/repo', currentVersion: '0.9.6', fetchImpl: listing({ tag_name: 'v0.9.7', assets: [{ name: 'notes.txt' }] }) });
  const result = await updater.check();
  assert.equal(result.state, 'current', 'nothing runnable is published yet');
  assert.equal(updater.pending(), null);
});

test('a network problem never crashes the app, it reports', async () => {
  const updater = createUpdater({ repo: 'owner/repo', currentVersion: '0.9.6', fetchImpl: async () => { throw new Error('offline'); } });
  const result = await updater.check();
  assert.equal(result.state, 'error');
  assert.match(result.message, /offline/);
});

test('no published release yet is not an error', async () => {
  const updater = createUpdater({ repo: 'owner/repo', currentVersion: '0.9.6', fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.equal((await updater.check()).state, 'current');
});

test('applying downloads once and hands the file to the installer', async () => {
  const seen = [];
  const updater = createUpdater({
    repo: 'owner/repo', currentVersion: '0.9.6', fetchImpl: listing(release('v0.9.7')),
    download: async target => { seen.push(['download', target.version]); return '/tmp/setup.exe'; },
    install: async file => { seen.push(['install', file]); }
  });
  await updater.check();
  const result = await updater.apply();
  assert.equal(result.state, 'installing');
  assert.deepEqual(seen, [['download', 'v0.9.7'], ['install', '/tmp/setup.exe']]);
});

test('applying without a checked update does nothing', async () => {
  const updater = createUpdater({ repo: 'owner/repo', currentVersion: '0.9.6', fetchImpl: listing(release('v0.9.7')) });
  assert.equal((await updater.apply()).state, 'error');
});

test('a failed download clears the offer so the button cannot loop', async () => {
  const updater = createUpdater({
    repo: 'owner/repo', currentVersion: '0.9.6', fetchImpl: listing(release('v0.9.7')),
    download: async () => { throw new Error('disk full'); },
    install: async () => {}
  });
  await updater.check();
  const result = await updater.apply();
  assert.equal(result.state, 'error');
  assert.match(result.message, /disk full/);
  assert.equal(updater.pending(), null);
});

test('a pre-release is still an update, and the highest version wins', async () => {
  const updater = createUpdater({
    repo: 'owner/repo', currentVersion: '0.9.7.36',
    fetchImpl: listing(release('v0.9.7.35'), { tag_name: 'v0.9.7.38', prerelease: true, assets: releases() }, release('v0.9.7.37'))
  });
  const result = await updater.check();
  assert.equal(result.state, 'available');
  assert.equal(result.version, 'v0.9.7.38', 'pre-releases are offered too: the pipeline publishes them that way');
});

test('drafts are ignored so an unpublished build is never offered', async () => {
  const updater = createUpdater({
    repo: 'owner/repo', currentVersion: '0.9.6',
    fetchImpl: listing({ tag_name: 'v0.9.9', draft: true, assets: releases() }, release('v0.9.7'))
  });
  assert.equal((await updater.check()).version, 'v0.9.7');
});

function releases() {
  return [{ name: 'GOLD-3Po-Setup-0.9.7-x64.exe', browser_download_url: 'https://example.test/setup.exe', size: 1 }];
}
