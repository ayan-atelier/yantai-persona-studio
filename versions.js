/* Explicit, user-triggered release switching for the native persona extension. */
export const PERSONA_VERSION = '1.0.8';
export const PERSONA_ID = 'yantai-persona-studio';
export const SETTINGS_SCHEMA = 3;
export const DEFAULT_REPOSITORY = 'https://github.com/ayan-atelier/yantai-persona-studio';

// Persona releases use the same frozen vX branches as the bookshelf, while
// development builds carry a prerelease suffix (for example -dev18).
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function parts(value) {
  const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error('版本号格式无效。');
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? match[4].split('.') : []];
}
export function compareVersions(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  const [xp, yp] = [x[3], y[3]];
  if (!xp.length || !yp.length) return xp.length === yp.length ? 0 : (xp.length ? -1 : 1);
  for (let i = 0; i < Math.max(xp.length, yp.length); i += 1) {
    if (xp[i] === undefined) return -1;
    if (yp[i] === undefined) return 1;
    const xn = /^\d+$/.test(xp[i]), yn = /^\d+$/.test(yp[i]);
    if (xn && yn && Number(xp[i]) !== Number(yp[i])) return Number(xp[i]) < Number(yp[i]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (xp[i] !== yp[i]) return xp[i] < yp[i] ? -1 : 1;
  }
  return 0;
}
export function repositoryURL(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(String(value).trim()); } catch { throw new Error('请填写完整的 GitHub 仓库网址。'); }
  const match = parsed.pathname.match(/^\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)\/?$/);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !match) throw new Error('请使用 https://github.com/作者/仓库名 这样的仓库网址。');
  const repo = match[2].replace(/\.git$/, '');
  if (!repo || repo === '.' || repo === '..') throw new Error('仓库名称无效。');
  return `https://github.com/${match[1]}/${repo}`;
}
export function releaseCatalog(value) {
  if (!value || value.schema !== 1 || value.extension !== PERSONA_ID || !Array.isArray(value.releases) || value.releases.length > 100) throw new Error('这个仓库没有可识别的砚台人设馆版本清单。');
  const seen = new Set();
  const releases = value.releases.map(release => {
    if (!release || !VERSION_PATTERN.test(release.version) || seen.has(release.version) || release.branch !== `v${release.version}` || !Number.isSafeInteger(release.settings_schema) || !VERSION_PATTERN.test(release.minimum_client_version)) throw new Error('版本清单不完整或包含重复版本，请等待作者修复。');
    if (release.commit !== undefined && release.commit !== '' && !/^[a-f0-9]{7,64}$/i.test(String(release.commit))) throw new Error('版本清单的提交校验值无效。');
    seen.add(release.version);
    return { ...release, notes: String(release.notes || '').slice(0, 4000), commit: String(release.commit || '') };
  }).sort((a, b) => compareVersions(b.version, a.version));
  if (!releases.some(release => release.version === value.latest)) throw new Error('版本清单缺少最新版。');
  return { latest: value.latest, releases };
}
export function versionSnapshot(settings, version) {
  const snapshot = JSON.parse(JSON.stringify(settings || {}));
  delete snapshot.versionBackup; delete snapshot.updateState;
  return { version, savedAt: new Date().toISOString(), settings: snapshot };
}

/**
 * Update manager for an installed native SillyTavern extension. It never
 * polls or mutates files until the user explicitly clicks a version action.
 */
export function createVersionManager({ settings, save, flush = save, context, moduleURL, apiRoot, beforeChange = async () => {}, fetcher = (...args) => fetch(...args), currentVersion = PERSONA_VERSION }) {
  let busy = false, disposed = false, reloadNeeded = false, clientVersion = '';
  const readControllers = new Set();
  const state = () => {
    const value = settings();
    if (!value.updateState || typeof value.updateState !== 'object' || Array.isArray(value.updateState)) value.updateState = {};
    return value.updateState;
  };
  const checkAlive = () => { if (disposed) throw new Error('人设馆已关闭，请重新打开。'); };
  const request = async (address, options = {}, mutating = false) => {
    checkAlive();
    const controller = new AbortController();
    if (!mutating) readControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), mutating ? 90000 : 30000);
    try {
      const response = await fetcher(address, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 403 ? '没有修改此扩展的权限，请由酒馆管理员操作。' : `请求失败（${response.status}），请检查网络和仓库发布状态。`);
      return await response.text();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(mutating ? '版本切换尚未确认完成，请刷新后查看版本号，不要连续重试。' : '检查超时或已取消，请稍后重试。');
      throw error;
    } finally { clearTimeout(timer); readControllers.delete(controller); }
  };
  const json = async (address, options, mutating = false) => {
    const text = await request(address, options, mutating);
    try { return text ? JSON.parse(text) : null; } catch { throw new Error('服务器返回内容无法识别，请稍后重试。'); }
  };
  const native = async (route, install, extra = {}, mutating = false) => json(new URL(`api/extensions/${route}`, apiRoot).href, { method: 'POST', headers: context().getRequestHeaders?.(), body: JSON.stringify({ extensionName: install.extensionName, global: install.global, ...extra }) }, mutating);
  const remoteText = (repo, path) => request(`https://raw.githubusercontent.com/${repo.slice('https://github.com/'.length)}/main/${path}`, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
  const remoteJSON = async (repo, path) => { try { return JSON.parse(await remoteText(repo, path)); } catch (error) { if (error instanceof SyntaxError) throw new Error('仓库中的版本清单不是有效 JSON。'); throw error; } };
  const resolveInstall = async () => {
    const match = new URL(moduleURL).pathname.match(/\/scripts\/extensions\/third-party\/([^/]+)\//);
    if (!match) throw new Error('无法识别人设馆安装目录。请通过酒馆的“安装扩展”使用仓库网址安装。');
    const extensionName = decodeURIComponent(match[1]);
    const discovered = await json(new URL('api/extensions/discover', apiRoot).href, { headers: context().getRequestHeaders?.() });
    const found = Array.isArray(discovered) && discovered.find(item => item.name === `third-party/${extensionName}` && ['local', 'global'].includes(item.type));
    if (!found) throw new Error('找不到当前人设馆的安装位置，请刷新酒馆后重试。');
    const install = { mode: 'native', extensionName, global: found.type === 'global' };
    const version = await native('version', install);
    if (!version?.remoteUrl || !version.currentCommitHash) throw new Error('这份人设馆是解压安装的。在线更新需要先改用仓库网址安装，现有人设馆设置和图库会保留。');
    return { ...install, ...version, repository: repositoryURL(version.remoteUrl) };
  };
  const compatible = release => release.settings_schema === SETTINGS_SCHEMA && VERSION_PATTERN.test(clientVersion) && compareVersions(clientVersion, release.minimum_client_version) >= 0;
  return {
    get busy() { return busy; }, get reloadNeeded() { return reloadNeeded; }, get mode() { return 'native'; },
    get repository() { return state().repository || DEFAULT_REPOSITORY; },
    setRepository(value) { if (busy) throw new Error('请等待当前检查结束。'); const repo = repositoryURL(value); state().repository = repo; save(); return repo; },
    async check() {
      if (busy) throw new Error('正在处理版本，请稍候。');
      if (reloadNeeded) throw new Error('版本已切换，请先刷新酒馆。');
      busy = true;
      try {
        const install = await resolveInstall();
        const client = await json(new URL('version', apiRoot).href, { cache: 'no-store' });
        clientVersion = String(client?.pkgVersion || '').match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] || '';
        if (!clientVersion) throw new Error('无法确认酒馆版本，暂不提供版本切换。');
        const catalog = releaseCatalog(await remoteJSON(install.repository, 'versions.json'));
        install.branches = await native('branches', install);
        if (!Array.isArray(install.branches)) throw new Error('当前酒馆未返回可切换版本，请先更新酒馆。');
        checkAlive();
        const available = catalog.releases.filter(release => compatible(release) && install.branches.some(branch => branch.name === `origin/${release.branch}`));
        const latest = available.find(release => release.version === catalog.latest);
        const previous = available.filter(release => compareVersions(release.version, currentVersion) < 0).at(0);
        return { install, catalog, latest: latest && compareVersions(latest.version, currentVersion) > 0 ? latest : null, previous, unavailableLatest: compareVersions(catalog.latest, currentVersion) > 0 && !latest, checkedAt: Date.now() };
      } finally { busy = false; }
    },
    async apply(checked, target) {
      if (busy) throw new Error('正在处理版本，请稍候。');
      if (reloadNeeded) throw new Error('版本已切换，请先刷新酒馆。');
      checkAlive();
      if (!checked || Date.now() - checked.checkedAt > 10 * 60 * 1000 || ![checked.latest, checked.previous].includes(target) || !target || !compatible(target)) throw new Error('版本信息已过期或不兼容，请重新检查。');
      busy = true; let mutationStarted = false;
      try {
        const install = await resolveInstall();
        if (install.repository !== checked.install.repository || install.mode !== checked.install.mode || install.currentCommitHash !== checked.install.currentCommitHash || install.currentBranchName !== checked.install.currentBranchName) throw new Error('安装来源或当前版本发生变化，请重新检查。');
        await beforeChange();
        const value = settings(); value.versionBackup = versionSnapshot(value, currentVersion);
        await flush(); checkAlive();
        mutationStarted = true;
        await native('switch', install, { branch: `origin/${target.branch}` }, true);
        const [manifest, actual] = await Promise.all([json(new URL('manifest.json', moduleURL).href, { cache: 'no-store' }), native('version', install)]);
        const expected = checked.install.branches.find(branch => branch.name === `origin/${target.branch}`);
        if (manifest?.version !== target.version || actual?.currentBranchName !== target.branch || (target.commit && !actual?.currentCommitHash?.startsWith(target.commit)) || (expected?.commit && !actual?.currentCommitHash?.startsWith(expected.commit))) throw new Error('切换后的版本未能通过核对，请刷新后检查扩展版本。');
        const s = state(); s.repository = install.repository; s.previousVersion = currentVersion; s.chosenVersion = target.version;
        await save(); await flush(); reloadNeeded = true; return target.version;
      } catch (error) {
        if (mutationStarted) { reloadNeeded = true; throw new Error(`${error.message} 请刷新酒馆确认当前版本；人设馆设置备份已保留。`); }
        throw error;
      } finally { busy = false; }
    },
    dispose() { disposed = true; for (const controller of readControllers) controller.abort(); readControllers.clear(); },
  };
}
