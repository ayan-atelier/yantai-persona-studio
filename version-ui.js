/* Single-main-branch update & branch-recovery dialog for 砚台 · 人设馆. */
export function openVersionDialog({ manager, element, button, dialog, currentVersion, notify, refresh }) {
  const { modal, body, notice } = dialog('人设馆版本与更新');
  const intro = element('p', 'ytps-version-intro', `当前版本 V${currentVersion}`);
  body.append(intro);
  let checked = null;
  const actions = element('div', 'ytps-version-actions');
  const details = element('p', 'ytps-version-notes');
  const check = button('检查更新', 'ytps-secondary-button', async () => {
    await run(async () => {
      checked = await manager.check();
      const branchHint = checked.needsMainSwitch ? `（当前位于旧分支 ${checked.currentBranchName}）` : '（main 主线）';
      intro.textContent = `当前版本 V${currentVersion} ${branchHint}`;
      if (checked.latest) {
        details.textContent = `最新版 V${checked.latest.version}\n${checked.latest.notes || ''}`.trim();
        notice.textContent = checked.needsMainSwitch
          ? `检测到当前停留在旧历史分支 ${checked.currentBranchName}，点击更新将自动切回 main 主线并升级至最新版。`
          : '发现可用更新；更新前会自动保存人设馆设置备份。';
      } else if (checked.unavailableLatest) {
        details.textContent = '';
        notice.textContent = '发现新版本，但需要更新的酒馆客户端版本才能使用。';
      } else {
        details.textContent = checked.latestInfo?.notes ? `当前已是最新版 V${checked.latestInfo.version}\n${checked.latestInfo.notes}` : '';
        notice.textContent = '当前已是 main 主线最新版本。';
      }
    });
  });
  const update = button('更新到最新版', 'ytps-primary-button', () => confirm(checked?.latest));
  const reload = button('刷新酒馆', 'ytps-primary-button', async () => {
    try { await refresh(); } catch (error) { notice.textContent = error.message; }
  });
  actions.append(check, update, reload);
  body.append(actions, details);
  body.append(element('small', 'ytps-version-help', '人设馆现已统一使用 main 主线更新（已开启酒馆自动更新支持），也可直接在酒馆「扩展 → 管理扩展」中点击更新；酒馆原生人设、头像和图库文件均保持原样。'));
  function sync() {
    actions.setAttribute('aria-busy', String(manager.busy));
    check.disabled = manager.busy || manager.reloadNeeded;
    update.disabled = manager.busy || manager.reloadNeeded || !checked?.latest;
    if (checked?.latest) {
      update.textContent = checked.needsMainSwitch
        ? `切回主线并更新到 V${checked.latest.version}`
        : `更新到 V${checked.latest.version}`;
    } else {
      update.textContent = '更新到最新版';
    }
    reload.hidden = !manager.reloadNeeded;
  }
  async function run(action) {
    notice.textContent = '正在处理，请稍候…';
    const promise = action(); sync();
    try { await promise; }
    catch (error) { notice.textContent = error.message; if (!modal.isConnected) notify(error.message); }
    finally { sync(); }
  }
  function confirm(target) {
    if (!target || manager.busy || manager.reloadNeeded) return;
    const prompt = dialog(checked?.needsMainSwitch ? `切回 main 主线并更新到 V${target.version}？` : `更新到 V${target.version}？`);
    prompt.body.append(element('p', 'ytps-version-intro', target.notes || '将拉取 main 主线最新版本，保留当前设置和图库。'));
    prompt.body.append(element('p', 'ytps-version-intro', '更新前会先保存设置备份。完成后请刷新酒馆，原生人设资料和头像文件不会被改写。'));
    const row = element('div', 'ytps-version-actions');
    const cancel = button('取消', 'ytps-secondary-button', () => prompt.modal.close());
    row.append(cancel, button('确认更新', 'ytps-primary-button', () => {
      prompt.modal.close();
      void run(async () => {
        const version = await manager.apply(checked, target);
        notice.textContent = `已更新到 V${version}（main 主线），请刷新酒馆。`;
        if (!modal.isConnected) notify(notice.textContent);
      });
    }));
    prompt.body.append(row); cancel.focus();
  }
  sync();
}
