/* Bookmark · 选项设置逻辑 */
(() => {
  'use strict';

  const DEFAULTS = {
    themeMode: 'auto',
    sortMode: 'folder-first',
    displayColumns: 'auto',
    showScrollbar: true,
    autoClose: true
  };

  /* 只用独立窗口形态，尺寸只受屏幕约束 */
  const WINDOW_LIMIT = {
    minW: 480, maxW: 1600, minH: 360, maxH: 1200,
    defaultW: 960, defaultH: 720
  };

  const SIZE_PRESETS = [
    { label: '紧凑', w: 720, h: 520 },
    { label: '标准', w: 960, h: 720 },
    { label: '高屏', w: 900, h: 900 },
    { label: '超大', w: 1200, h: 1000 }
  ];

  const $ = (id) => document.getElementById(id);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  const state = {
    settings: Object.assign({}, DEFAULTS),
    windowSize: { w: WINDOW_LIMIT.defaultW, h: WINDOW_LIMIT.defaultH },
    folderTree: [],
    saveTimer: null
  };

  /* ---------------- 通用 ---------------- */

  function flash(message, isError) {
    const el = $('saveState');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => el.classList.remove('show'), 1500);
  }

  function applyTheme(mode) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = mode === 'dark' || (mode !== 'light' && prefersDark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('bp_theme', dark ? 'dark' : 'light');
    } catch (error) {
      /* 忽略 */
    }
  }

  async function saveSync(patch) {
    state.settings = Object.assign({}, state.settings, patch);
    try {
      await browser.storage.sync.set(patch);
      flash('已保存');
    } catch (error) {
      console.error('[Bookmark] 保存失败:', error);
      flash('保存失败', true);
    }
  }

  /** 窗口尺寸：直接决定下次（以及当前）窗口多大 */
  async function saveWindowSize(size) {
    state.windowSize = {
      w: clamp(Math.round(size.w), WINDOW_LIMIT.minW, WINDOW_LIMIT.maxW),
      h: clamp(Math.round(size.h), WINDOW_LIMIT.minH, WINDOW_LIMIT.maxH)
    };
    updateSizeUi();
    try {
      await browser.storage.local.set({
        windowSize: { width: state.windowSize.w, height: state.windowSize.h }
      });
      flash('窗口尺寸已保存');
    } catch (error) {
      console.error('[Bookmark] 保存窗口尺寸失败:', error);
      flash('保存失败', true);
    }

    // 已有窗口就立刻缩放它
    try {
      const size = { width: state.windowSize.w, height: state.windowSize.h };
      await browser.runtime.sendMessage({ type: 'open-window', size });
    } catch (error) {
      /* 没有窗口时忽略 */
    }
  }

  /* ---------------- 加载 ---------------- */

  async function loadSettings() {
    const [syncData, localData] = await Promise.all([
      browser.storage.sync.get(),
      browser.storage.local.get(['windowSize'])
    ]);

    state.settings = Object.assign({}, DEFAULTS, syncData || {});

    const win = localData.windowSize;
    if (win && Number(win.width) > 0 && Number(win.height) > 0) {
      state.windowSize = {
        w: clamp(Math.round(win.width), WINDOW_LIMIT.minW, WINDOW_LIMIT.maxW),
        h: clamp(Math.round(win.height), WINDOW_LIMIT.minH, WINDOW_LIMIT.maxH)
      };
    }
  }

  async function loadBookmarkTree() {
    try {
      state.folderTree = await browser.bookmarks.getTree();
    } catch (error) {
      console.error('[Bookmark] 读取书签失败:', error);
      state.folderTree = [];
    }
  }

  function findToolbarId() {
    let found = '';
    const walk = (nodes) => {
      nodes.forEach((node) => {
        if (!node.children) return;
        if (!found) {
          const title = (node.title || '').toLowerCase();
          if (node.id === 'toolbar_____' || title.includes('toolbar') ||
              title.includes('书签工具栏') || title.includes('书签栏')) {
            found = node.id;
          }
        }
        walk(node.children);
      });
    };
    walk(state.folderTree);
    return found;
  }

  function buildFolderSelect() {
    const select = $('defaultFolder');
    select.textContent = '';

    const root = state.folderTree[0];
    if (!root) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '（无法读取书签）';
      select.appendChild(option);
      return;
    }

    const addOption = (value, label) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };

    addOption(root.id, '根目录（全部书签）');

    const walk = (nodes, depth) => {
      nodes.forEach((node) => {
        if (!node.children) return;
        const label = (node.title || '未命名文件夹') + (node.children.length ? `  (${node.children.length})` : '');
        addOption(node.id, '　'.repeat(depth) + (depth > 0 ? '└ ' : '') + label);
        walk(node.children, depth + 1);
      });
    };
    walk(root.children || [], 0);

    let current = state.settings.defaultFolderId;
    if (current === undefined || current === null) current = findToolbarId();
    if (!current || !select.querySelector(`option[value="${CSS.escape(current)}"]`)) {
      current = root.id;
    }
    select.value = current;
  }

  /* ---------------- 渲染控件 ---------------- */

  function fillControls() {
    $('themeMode').value = state.settings.themeMode || 'auto';
    $('displayColumns').value = state.settings.displayColumns || 'auto';
    $('sortMode').value = state.settings.sortMode || 'folder-first';
    $('showScrollbar').checked = !!state.settings.showScrollbar;
    $('autoClose').checked = !!state.settings.autoClose;

    initSizeControls();
    updateWindowHint();

    $('versionText').textContent = `Bookmark ${browser.runtime.getManifest().version}`;
  }

  function updateWindowHint() {
    const { w, h } = state.windowSize || {};
    $('windowSizeHint').textContent = w && h
      ? `当前记录：${w} × ${h}，拖动窗口边框会同步更新`
      : `默认 ${WINDOW_LIMIT.defaultW} × ${WINDOW_LIMIT.defaultH}`;
  }

  /** 初始化滑块范围与预设按钮（只有一种形态，调用一次即可） */
  function initSizeControls() {
    const sliderW = $('sizeW');
    const sliderH = $('sizeH');
    sliderW.min = String(WINDOW_LIMIT.minW);
    sliderW.max = String(WINDOW_LIMIT.maxW);
    sliderH.min = String(WINDOW_LIMIT.minH);
    sliderH.max = String(WINDOW_LIMIT.maxH);

    const row = $('sizePresets');
    const resetChip = $('resetSize');
    row.querySelectorAll('.chip[data-size]').forEach((chip) => chip.remove());
    SIZE_PRESETS.forEach((preset) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.size = `${preset.w},${preset.h}`;
      chip.textContent = preset.label;
      row.insertBefore(chip, resetChip);
    });

    updateSizeUi();
  }

  function updateSizeUi() {
    const { w, h } = state.windowSize;
    $('sizeW').value = w;
    $('sizeH').value = h;
    $('sizeWOut').textContent = w;
    $('sizeHOut').textContent = h;
    $('sizePreviewLabel').textContent = `${w} × ${h}`;

    const box = $('sizePreview');
    const inner = $('sizePreviewInner');
    const maxW = Math.max(60, box.clientWidth - 24);
    const maxH = Math.max(40, box.clientHeight - 24);
    const scale = Math.min(maxW / w, maxH / h);
    inner.style.width = Math.round(w * scale) + 'px';
    inner.style.height = Math.round(h * scale) + 'px';

    const row = $('sizePresets');
    if (row) {
      row.querySelectorAll('.chip[data-size]').forEach((chip) => {
        const [cw, ch] = chip.dataset.size.split(',').map(Number);
        chip.classList.toggle('is-active', cw === w && ch === h);
      });
    }
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    $('themeMode').addEventListener('change', (event) => {
      const mode = event.target.value;
      applyTheme(mode);
      saveSync({ themeMode: mode });
    });

    $('displayColumns').addEventListener('change', (event) => {
      saveSync({ displayColumns: event.target.value });
    });

    $('sortMode').addEventListener('change', (event) => {
      saveSync({ sortMode: event.target.value });
    });

    $('showScrollbar').addEventListener('change', (event) => {
      saveSync({ showScrollbar: event.target.checked });
    });

    $('autoClose').addEventListener('change', (event) => {
      saveSync({ autoClose: event.target.checked });
    });

    $('defaultFolder').addEventListener('change', (event) => {
      saveSync({ defaultFolderId: event.target.value });
    });

    const onSizeInput = () => {
      const size = {
        w: clamp(Number($('sizeW').value), WINDOW_LIMIT.minW, WINDOW_LIMIT.maxW),
        h: clamp(Number($('sizeH').value), WINDOW_LIMIT.minH, WINDOW_LIMIT.maxH)
      };
      state.windowSize = size;
      updateSizeUi();
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => saveWindowSize(size), 220);
    };

    $('sizeW').addEventListener('input', onSizeInput);
    $('sizeH').addEventListener('input', onSizeInput);

    $('sizePresets').addEventListener('click', (event) => {
      const chip = event.target.closest('.chip[data-size]');
      if (!chip) return;
      const [w, h] = chip.dataset.size.split(',').map(Number);
      saveWindowSize({ w, h });
    });

    $('resetSize').addEventListener('click', () => {
      saveWindowSize({ w: WINDOW_LIMIT.defaultW, h: WINDOW_LIMIT.defaultH });
    });

    $('openWindowBtn').addEventListener('click', async () => {
      try {
        await browser.runtime.sendMessage({
          type: 'open-window',
          size: { width: state.windowSize.w, height: state.windowSize.h }
        });
      } catch (error) {
        console.error('[Bookmark] 打开窗口失败:', error);
        flash('打开失败', true);
      }
    });

    $('resetWindowSize').addEventListener('click', async () => {
      try {
        await browser.storage.local.remove('windowSize');
        state.windowSize = { w: WINDOW_LIMIT.defaultW, h: WINDOW_LIMIT.defaultH };
        updateWindowHint();
        updateSizeUi();
        flash('窗口尺寸记录已清除');
      } catch (error) {
        console.error('[Bookmark] 清除窗口尺寸失败:', error);
      }
    });

    $('resetAll').addEventListener('click', async () => {
      if (!window.confirm('恢复全部默认设置？主题、列数、窗口尺寸、默认文件夹等都会重置。')) return;
      try {
        await browser.storage.sync.remove(Object.keys(DEFAULTS).concat(['defaultFolderId']));
        await browser.storage.local.remove(['windowSize', 'popupSize']);
        await loadSettings();
        state.windowSize = { w: WINDOW_LIMIT.defaultW, h: WINDOW_LIMIT.defaultH };
        applyTheme(state.settings.themeMode);
        fillControls();
        buildFolderSelect();
        flash('已恢复默认设置');
      } catch (error) {
        console.error('[Bookmark] 重置失败:', error);
        flash('重置失败', true);
      }
    });

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') {
        if (changes.themeMode) {
          state.settings.themeMode = changes.themeMode.newValue || 'auto';
          $('themeMode').value = state.settings.themeMode;
          applyTheme(state.settings.themeMode);
        }
        if (changes.displayColumns) {
          state.settings.displayColumns = changes.displayColumns.newValue || 'auto';
          $('displayColumns').value = state.settings.displayColumns;
        }
        if (changes.sortMode) {
          state.settings.sortMode = changes.sortMode.newValue || 'folder-first';
          $('sortMode').value = state.settings.sortMode;
        }
        if (changes.showScrollbar) {
          state.settings.showScrollbar = !!changes.showScrollbar.newValue;
          $('showScrollbar').checked = state.settings.showScrollbar;
        }
        if (changes.autoClose) {
          state.settings.autoClose = !!changes.autoClose.newValue;
          $('autoClose').checked = state.settings.autoClose;
        }
        if (changes.defaultFolderId) {
          state.settings.defaultFolderId = changes.defaultFolderId.newValue;
          buildFolderSelect();
        }
      }

      if (area === 'local' && changes.windowSize) {
        const next = changes.windowSize.newValue;
        if (next && Number(next.width) > 0 && Number(next.height) > 0) {
          state.windowSize = {
            w: clamp(Math.round(next.width), WINDOW_LIMIT.minW, WINDOW_LIMIT.maxW),
            h: clamp(Math.round(next.height), WINDOW_LIMIT.minH, WINDOW_LIMIT.maxH)
          };
        } else {
          state.windowSize = { w: WINDOW_LIMIT.defaultW, h: WINDOW_LIMIT.defaultH };
        }
        updateWindowHint();
        updateSizeUi();
      }
    });

    window.addEventListener('resize', () => updateSizeUi());
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    try {
      await loadSettings();
    } catch (error) {
      console.error('[Bookmark] 读取设置失败:', error);
    }

    applyTheme(state.settings.themeMode);
    await loadBookmarkTree();
    fillControls();
    buildFolderSelect();
    bind();
  }

  init();
})();
