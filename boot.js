/* Bookmark · 首屏引导
 * 在 <head> 中同步执行，先按上次的主题渲染一帧，避免打开时闪一下亮色。
 * 真正的持久化在 storage.sync，这里只是 localStorage 同步镜像。
 *
 * 窗口尺寸由浏览器管理（拖边框 + storage.local.windowSize），
 * 不再需要在这里预设画布大小。
 */
(() => {
  'use strict';

  const THEME_KEY = 'bp_theme';

  try {
    const mode = localStorage.getItem(THEME_KEY);
    if (mode === 'dark' || mode === 'light') {
      document.documentElement.dataset.theme = mode;
    }
  } catch (error) {
    /* 忽略 */
  }
})();
