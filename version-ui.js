/* Compact, explicit release controls for the persona extension settings. */
export function openVersionDialog({ manager, element, button, dialog, currentVersion, notify, refresh }) {
  const { modal, body, notice } = dialog('人设馆版本');
  body.append(element('p', 'ytps-version-intro', `当前版本 V${currentVersion}`));
  let checked = null;
  const actions = element('div', 'ytps-version-actions');
  const details = element('p', 'ytps-version-notes');
  const check = button('检查更新', 'ytps-secondary-button', async () => {
    await run(async () => {
      checked = await manager.check();
      details.textContent = checked.latest ? `V${checked.latest.version}\n${checked.latest.notes}` : checked.unavailableLatest ? '新版暂未完成发布或与当前酒馆不兼容。' : '当前没有可用的新版本。';
      notice.textContent = checked.previous ? `可退回 V${checked.previous.version}。切换前会保存人设馆设置备份。` : '暂无更早的兼容版本可回退。';
    });
  });
  const update = button('更新到最新版', 'ytps-primary-button', () => confirm(checked?.latest));
  const rollback = button('退回上一版本', 'ytps-secondary-button', () => confirm(checked?.previous));
  const reload = button('刷新酒馆', 'ytps-primary-button', async () => {
    try { await refresh(); } catch (error) { notice.textContent = error.message; }
  });
  actions.append(check, update, rollback, reload); body.append(actions, details);
  body.append(element('small', 'ytps-version-help', '只在你点击时检查或切换版本。切换前会备份人设馆设置；酒馆原生人设、头像和图库文件保持原样。'));
  function sync() {
    actions.setAttribute('aria-busy', String(manager.busy));
    check.disabled = manager.busy || manager.reloadNeeded;
    update.disabled = manager.busy || manager.reloadNeeded || !checked?.latest;
    rollback.disabled = manager.busy || manager.reloadNeeded || !checked?.previous;
    update.textContent = checked?.latest ? `更新到 V${checked.latest.version}` : '更新到最新版';
    rollback.textContent = checked?.previous ? `退回 V${checked.previous.version}` : '退回上一版本';
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
    const prompt = dialog(`切换到 V${target.version}？`);
    prompt.body.append(element('p', 'ytps-version-intro', target.notes || '将切换人设馆程序版本，保留当前设置和图库。'));
    prompt.body.append(element('p', 'ytps-version-intro', '会先保存设置备份。切换完成后请刷新酒馆，原生人设资料和头像文件不会被改写。'));
    const row = element('div', 'ytps-version-actions');
    const cancel = button('取消', 'ytps-secondary-button', () => prompt.modal.close());
    row.append(cancel, button('确认切换', 'ytps-primary-button', () => {
      prompt.modal.close();
      void run(async () => {
        const version = await manager.apply(checked, target);
        notice.textContent = `已切换到 V${version}，请刷新酒馆。`;
        if (!modal.isConnected) notify(notice.textContent);
      });
    }));
    prompt.body.append(row); cancel.focus();
  }
  sync();
}
