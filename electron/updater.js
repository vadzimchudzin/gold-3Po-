// In-app updates without pulling in a dependency: read the newest published release, compare it with
// the running version, download the installer and hand it to Windows. The decision rules are pure so
// they can be tested without touching the network or the disk.
const RELEASE_API = 'https://api.github.com/repos';

export function parseVersion(text) {
  const match = String(text ?? '').trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)]
  };
}

// Numeric comparison, part by part: 0.9.10 is newer than 0.9.9, and a missing part counts as zero.
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < a.parts.length; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  return 0;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

// The Windows installer is the only asset the update can run.
export function pickInstaller(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const setup = assets.find(asset => /\.exe$/i.test(asset?.name || '') && asset?.browser_download_url);
  if (!setup) return null;
  return { name: setup.name, url: setup.browser_download_url, size: Number(setup.size) || 0 };
}

export function releaseNotes(release, limit = 700) {
  const text = String(release?.body ?? '').replace(/\r/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function createUpdater({ repo, currentVersion, fetchImpl = (...args) => fetch(...args), download, install, log = () => {} }) {
  let pending = null;

  async function check() {
    if (!repo) return { state: 'unsupported', message: 'Сборка не знает свой репозиторий.' };
    let response;
    try {
      response = await fetchImpl(`${RELEASE_API}/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    } catch (error) {
      return { state: 'error', message: `Нет связи с сервером обновлений: ${error?.message || error}` };
    }
    if (response.status === 404) return { state: 'current', currentVersion, message: 'Опубликованных обновлений ещё нет.' };
    if (!response.ok) return { state: 'error', message: `Сервер обновлений ответил HTTP ${response.status}.` };
    let release;
    try { release = await response.json(); }
    catch { return { state: 'error', message: 'Ответ сервера обновлений не читается.' }; }

    const tag = release?.tag_name || release?.name || '';
    if (!isNewer(tag, currentVersion)) return { state: 'current', currentVersion, latest: tag, message: 'Установлена последняя версия.' };
    const installer = pickInstaller(release);
    if (!installer) return { state: 'error', version: tag, message: 'В релизе нет установщика Windows.' };
    pending = { version: tag, ...installer, notes: releaseNotes(release) };
    log(`update available: ${tag}`);
    return { state: 'available', currentVersion, ...pending };
  }

  async function apply() {
    if (!pending) return { state: 'error', message: 'Нет загруженного обновления.' };
    const target = pending;
    try {
      const file = await download(target);
      await install(file);
      return { state: 'installing', version: target.version };
    } catch (error) {
      pending = null;
      return { state: 'error', message: `Не удалось установить обновление: ${error?.message || error}` };
    }
  }

  return { check, apply, pending: () => pending };
}
