/* Bookmark - 后台脚本
 * 职责：
 *  1. 点击工具栏图标 → 打开（或聚焦）独立窗口
 *  2. 记住并复用独立窗口的尺寸
 *
 * 说明：本扩展只以「独立窗口」形态工作，不再使用工具栏弹窗。
 * manifest 里没有 default_popup，所以点击图标一定会触发 browserAction.onClicked。
 */
'use strict';

const WINDOW_PAGE = 'popup.html?surface=window';
const DEFAULT_WINDOW_SIZE = { width: 960, height: 720 };
const MIN_WINDOW = { width: 480, height: 360 };
const MAX_WINDOW = { width: 1600, height: 1200 };

/* ---------- 查找已存在的窗口 ---------- */

async function getOurWindows() {
  const wins = await browser.windows.getAll({ populate: true });
  const target = browser.runtime.getURL(WINDOW_PAGE);
  const base = browser.runtime.getURL('popup.html');
  return wins.filter((win) =>
    (win.tabs || []).some((tab) => tab.url && (tab.url === target || tab.url.startsWith(base + '?surface=window')))
  );
}

/* ---------- 尺寸 ---------- */

function clampSize(size) {
  const width = Math.min(MAX_WINDOW.width, Math.max(MIN_WINDOW.width, Math.round(Number(size.width) || 0)));
  const height = Math.min(MAX_WINDOW.height, Math.max(MIN_WINDOW.height, Math.round(Number(size.height) || 0)));
  return { width, height };
}

async function resolveSize(requested) {
  if (requested && Number(requested.width) > 0 && Number(requested.height) > 0) {
    return clampSize(requested);
  }
  try {
    const stored = await browser.storage.local.get('windowSize');
    const saved = stored.windowSize;
    if (saved && Number(saved.width) > 0 && Number(saved.height) > 0) return clampSize(saved);
  } catch (error) {
    console.error('[Bookmark] 读取窗口尺寸失败:', error);
  }
  return DEFAULT_WINDOW_SIZE;
}

/* ---------- 打开 / 复用窗口 ---------- */

async function openWindow(requested) {
  const size = await resolveSize(requested);
  const existing = await getOurWindows();

  if (existing.length > 0) {
    const win = existing[0];
    const updates = { focused: true };
    // 明确指定了尺寸才调整现有窗口，否则只聚焦，保留用户手动拖过的大小
    if (requested) {
      updates.width = size.width;
      updates.height = size.height;
      updates.state = 'normal';
    }
    await browser.windows.update(win.id, updates);
    return win.id;
  }

  const created = await browser.windows.create({
    url: browser.runtime.getURL(WINDOW_PAGE),
    type: 'popup',
    width: size.width,
    height: size.height,
    allowScriptsToClose: true
  });
  return created.id;
}

/* ---------- 点击工具栏图标 ---------- */

browser.browserAction.onClicked.addListener(() => {
  openWindow().catch((error) => console.error('[Bookmark] 打开独立窗口失败:', error));
});

/* ---------- 消息 ---------- */

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'open-window') return undefined;
  return openWindow(message.size);
});

/* ---------- 安装时把可能残留的 popup 清掉 ----------
 * 旧版本用过 browserAction.setPopup 切换行为，可能留有 popup.html 的设置。
 * 这里显式置空，保证点击一定走 onclicked。
 */
async function ensureNoPopup() {
  try {
    await browser.browserAction.setPopup({ popup: '' });
  } catch (error) {
    console.error('[Bookmark] 清除工具栏弹窗失败:', error);
  }
}

browser.runtime.onInstalled.addListener(() => {
  ensureNoPopup();
});

browser.runtime.onStartup.addListener(() => {
  ensureNoPopup();
});

ensureNoPopup();
