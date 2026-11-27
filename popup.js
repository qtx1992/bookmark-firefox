/* =========================================================
   Bookmark - 简洁书签 · popup 逻辑
   - 同一份界面可运行在「工具栏弹窗」和「独立窗口」两种载体
   - 显示范围可调：弹窗内拖动右下角手柄 / 设置面板 / 独立窗口原生缩放
   - 滚动条始终隐藏，滚轮与触控板仍可浏览
   ========================================================= */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function makeSvg(paths, viewBox, extra) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    if (extra) {
      Object.keys(extra).forEach((key) => svg.setAttribute(key, extra[key]));
    }
    paths.forEach((path) => {
      const el = document.createElementNS(SVG_NS, path.tag || 'path');
      Object.keys(path.attrs).forEach((key) => el.setAttribute(key, path.attrs[key]));
      svg.appendChild(el);
    });
    return svg;
  }

  function buildFallbackIcon() {
    const svg = makeSvg([
      { attrs: { cx: '16', cy: '16', r: '11.2', fill: 'none', stroke: '#8b97ad', 'stroke-width': '2' }, tag: 'circle' },
      { attrs: { cx: '16', cy: '16', rx: '5', ry: '11.2', fill: 'none', stroke: '#8b97ad', 'stroke-width': '2' }, tag: 'ellipse' },
      { attrs: { d: 'M5.2 16h21.6M7.6 10.4h16.8M7.6 21.6h16.8', fill: 'none', stroke: '#8b97ad', 'stroke-width': '2' } }
    ], '0 0 32 32', { xmlns: SVG_NS });
    const markup = new XMLSerializer().serializeToString(svg);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
  }

  const FALLBACK_ICON = buildFallbackIcon();

  function buildFolderIcon() {
    return makeSvg([
      {
        attrs: {
          d: 'M3 7.2A2.7 2.7 0 0 1 5.7 4.5h3.4c.66 0 1.29.26 1.76.72l.9.88c.26.26.62.4.99.4h5.55A2.7 2.7 0 0 1 21 9.2v7.3a2.7 2.7 0 0 1-2.7 2.7H5.7A2.7 2.7 0 0 1 3 16.5V7.2Z',
          fill: '#f0b45c'
        }
      },
      {
        attrs: {
          d: 'M3 10.6h18v5.9a2.7 2.7 0 0 1-2.7 2.7H5.7A2.7 2.7 0 0 1 3 16.5v-5.9Z',
          fill: '#f9d089'
        }
      }
    ], '0 0 24 24');
  }

  const DEFAULT_SETTINGS = {
    themeMode: 'auto',
    sortMode: 'folder-first',
    showScrollbar: true,
    autoClose: true
  };

  /* 只用独立窗口形态，尺寸只受屏幕约束 */
  const WINDOW_LIMIT = {
    minW: 480, maxW: 1600,
    minH: 360, maxH: 1200,
    defaultW: 960, defaultH: 720
  };

  const SIZE_PRESETS = [
    { label: '紧凑', w: 720, h: 520 },
    { label: '标准', w: 960, h: 720 },
    { label: '高屏', w: 900, h: 900 },
    { label: '超大', w: 1200, h: 1000 }
  ];

  const ICON_CACHE_KEY = 'bp_icon_cache_v1';
  const ICON_TTL = 7 * 24 * 60 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hostOf(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.hostname;
    } catch (error) {
      return '';
    }
  }

  class BookmarkApp {
    constructor() {
      // 只以独立窗口形态运行
      this.surface = 'window';

      this.settings = Object.assign({}, DEFAULT_SETTINGS);
      this.windowSize = { w: WINDOW_LIMIT.defaultW, h: WINDOW_LIMIT.defaultH };

      this.tree = [];
      this.nodeMap = new Map();
      this.bookmarks = [];
      this.currentFolderId = '';
      this.query = '';
      this.searchTimer = null;

      this.contextTarget = null;
      this.editTarget = null;
      this.dragState = null;
      this.autoScrollRaf = null;
      this.autoScrollDirection = 0;
      this.autoScrollTimer = null;
      this.toastTimer = null;

      this.iconCache = this.loadIconCache();
      this.iconFlushTimer = null;

      this.lastCount = 0;
      this.lastSearching = false;

      this.els = {};
    }

    /* ---------------- 初始化 ---------------- */

    async init() {
      this.cacheElements();
      this.applySurfaceClass();

      try {
        await this.loadSettings();
      } catch (error) {
        console.error('[Bookmark] 读取设置失败:', error);
      }

      this.applyTheme(this.settings.themeMode);
      this.applyColumns(this.settings.displayColumns);
      this.applyScrollbarMode(this.settings.showScrollbar);
      this.applyAutoClose(this.settings.autoClose);

      this.bindEvents();
      this.watchSystemTheme();

      await this.loadTree();
      this.currentFolderId = this.resolveStartFolder();
      this.render();

      // 后台预热图标缓存清理
      this.pruneIconCache();
    }

    cacheElements() {
      const ids = [
        'searchInput', 'searchClear', 'menuBtn',
        'breadcrumb', 'breadcrumbItems', 'backButton',
        'searchSummary', 'searchSummaryText', 'searchReset',
        'scrollWrap', 'bookmarkGrid', 'emptyState',
        'statusText', 'statusCount', 'statusScrollHint',
        'autoCloseToggle', 'autoCloseInput',
        'contextMenu', 'mainMenu',
        'sizePop', 'sizeCurrent', 'sizePresets', 'sizeTip', 'sizeW', 'sizeH', 'sizeApply', 'sizeCancel',
        'editOverlay', 'editTitle', 'editName', 'editUrl', 'urlField', 'editCancel', 'editSave',
        'confirmOverlay', 'confirmTitle', 'confirmText', 'confirmCancel', 'confirmOk',
        'toast'
      ];
      ids.forEach((id) => {
        this.els[id] = $(id);
      });
      this.grid = this.els.bookmarkGrid;
      this.wrap = this.els.scrollWrap;
    }

    applySurfaceClass() {
      document.documentElement.classList.add('surface-' + this.surface);
      document.body.classList.add('surface-' + this.surface);
    }

    /* ---------------- 设置 ---------------- */

    async loadSettings() {
      const [syncData, localData] = await Promise.all([
        browser.storage.sync.get(),
        browser.storage.local.get(['windowSize'])
      ]);

      this.settings = Object.assign({}, DEFAULT_SETTINGS, syncData || {});

      const win = localData.windowSize;
      if (win && Number(win.width) > 0 && Number(win.height) > 0) {
        this.windowSize = {
          w: clamp(Math.round(win.width), WINDOW_LIMIT.minW, WINDOW_LIMIT.maxW),
          h: clamp(Math.round(win.height), WINDOW_LIMIT.minH, WINDOW_LIMIT.maxH)
        };
      }
    }

    async saveSettings(patch) {
      this.settings = Object.assign({}, this.settings, patch);
      try {
        await browser.storage.sync.set(patch);
      } catch (error) {
        console.error('[Bookmark] 保存设置失败:', error);
        this.toast('保存设置失败');
      }
    }

    applyTheme(mode) {
      this.settings.themeMode = mode;
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const dark = mode === 'dark' || (mode !== 'light' && prefersDark);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      this.mirrorTheme(dark ? 'dark' : 'light');
    }

    mirrorTheme(resolved) {
      try {
        localStorage.setItem('bp_theme', resolved);
      } catch (error) {
        /* 忽略 */
      }
    }

    watchSystemTheme() {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => {
        if (this.settings.themeMode === 'auto') this.applyTheme('auto');
      };
      if (media.addEventListener) media.addEventListener('change', handler);
      else if (media.addListener) media.addListener(handler);
    }

    applyColumns(columns) {
      this.settings.displayColumns = columns;
      const grid = this.grid;
      if (!grid) return;
      if (columns === '1' || columns === '2' || columns === '3') {
        grid.style.gridTemplateColumns = `repeat(${Number(columns)}, minmax(0, 1fr))`;
      } else {
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(200px, 1fr))';
      }
      requestAnimationFrame(() => this.updateScrollHints());
    }

    applyScrollbarMode(show) {
      this.settings.showScrollbar = !!show;
      // 默认显示滚动条；关掉时加 hide-scrollbar 类
      document.body.classList.toggle('hide-scrollbar', !show);
    }

    applyAutoClose(enabled) {
      this.settings.autoClose = !!enabled;
      if (this.els.autoCloseInput) {
        this.els.autoCloseInput.checked = !!enabled;
      }
      const toggle = this.els.autoCloseToggle;
      if (toggle) {
        toggle.title = enabled
          ? '打开书签后自动关闭本窗口（点击关闭）'
          : '打开书签后保持窗口（点击开启自动关闭）';
      }
    }

    /* ---------------- 窗口尺寸 ----------------
     * 只用独立窗口形态：内容铺满整个窗口，尺寸由浏览器原生拖拽边框控制。
     * 这里只负责把用户拖出来的尺寸记下来，供下次打开时使用。
     */

    watchWindowResize() {
      let timer = null;
      const save = () => {
        const size = {
          width: window.outerWidth || window.innerWidth,
          height: window.outerHeight || window.innerHeight
        };
        this.windowSize = {
          w: clamp(size.width, WINDOW_LIMIT.minW, WINDOW_LIMIT.maxW),
          h: clamp(size.height, WINDOW_LIMIT.minH, WINDOW_LIMIT.maxH)
        };
        browser.storage.local.set({ windowSize: size }).catch(() => {});
      };
      window.addEventListener('resize', () => {
        clearTimeout(timer);
        timer = setTimeout(save, 400);
        this.updateScrollHints();
      });
    }

    /* ---------------- 书签数据 ---------------- */

    async loadTree() {
      this.tree = await browser.bookmarks.getTree();
      this.nodeMap.clear();
      this.bookmarks = [];

      const walk = (nodes) => {
        nodes.forEach((node) => {
          this.nodeMap.set(node.id, node);
          if (node.children) {
            walk(node.children);
          } else if (node.url) {
            this.bookmarks.push(node);
          }
        });
      };
      walk(this.tree);
    }

    resolveStartFolder() {
      const root = this.tree[0];
      if (!root) return '';

      let id = this.settings.defaultFolderId;
      if (id === undefined || id === null) {
        id = this.findToolbarFolder() || '';
        this.saveSettings({ defaultFolderId: id });
      }

      if (id && this.nodeMap.has(id)) return id;
      return root.id;
    }

    findToolbarFolder() {
      let found = null;
      this.nodeMap.forEach((node) => {
        if (found || !node.children) return;
        if (node.id === 'toolbar_____') {
          found = node.id;
          return;
        }
        const title = (node.title || '').toLowerCase();
        if (title.includes('toolbar') || title.includes('书签栏') || title.includes('书签工具栏')) {
          found = node.id;
        }
      });
      return found;
    }

    get currentFolder() {
      return this.nodeMap.get(this.currentFolderId) || this.tree[0];
    }

    folderPath(folderId) {
      const path = [];
      let node = this.nodeMap.get(folderId);
      let guard = 0;
      while (node && guard < 100) {
        path.unshift(node);
        if (!node.parentId) break;
        node = this.nodeMap.get(node.parentId);
        guard += 1;
      }
      return path;
    }

    getFolderContents(folder) {
      if (!folder || !folder.children) return [];
      const children = folder.children.slice();

      if (this.settings.sortMode === 'natural') {
        return children.filter((item) => item.children || item.url);
      }

      const folders = children.filter((item) => item.children);
      const bookmarks = children.filter((item) => !item.children && item.url);
      return folders.concat(bookmarks);
    }

    /* ---------------- 渲染 ---------------- */

    render() {
      // 重建 DOM 前先结束可能残留的拖拽，避免源元素被移除后状态和滚动计时器失控
      if (this.dragState || this.autoScrollRaf) this.endDrag();

      const searching = !!this.query;
      const items = searching ? this.searchResults() : this.getFolderContents(this.currentFolder);

      this.renderBreadcrumb(searching);
      this.renderCards(items, searching);

      const empty = this.els.emptyState;
      if (items.length === 0) {
        empty.hidden = false;
        const title = empty.querySelector('.empty-title');
        const hint = empty.querySelector('.empty-hint');
        if (searching) {
          title.textContent = '没有匹配的书签';
          hint.textContent = `没有找到包含“${this.query}”的书签，换个关键词试试`;
        } else {
          title.textContent = '这里没有书签';
          hint.textContent = '在 Firefox 中往这个文件夹添加书签后会自动出现';
        }
      } else {
        empty.hidden = true;
      }

      this.prefetchIcons();
      this.updateStatus(items.length, searching);
      requestAnimationFrame(() => this.updateScrollHints());
    }

    renderBreadcrumb(searching) {
      const breadcrumb = this.els.breadcrumb;
      const summary = this.els.searchSummary;

      if (searching) {
        breadcrumb.hidden = true;
        summary.hidden = false;
        const count = this.searchResults().length;
        const text = this.els.searchSummaryText;
        text.textContent = '';
        text.appendChild(document.createTextNode('搜索 “'));
        const keyword = document.createElement('b');
        keyword.textContent = this.query;
        text.appendChild(keyword);
        text.appendChild(document.createTextNode(`” · 共 ${count} 个结果`));
        return;
      }

      breadcrumb.hidden = false;
      summary.hidden = true;

      const items = this.els.breadcrumbItems;
      items.textContent = '';

      const path = this.folderPath(this.currentFolderId);
      path.forEach((node, index) => {
        const isCurrent = index === path.length - 1;
        const label = node.title || (node.id === 'root________' ? '根目录' : '未命名');

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'crumb' + (isCurrent ? ' current' : '');
        button.textContent = label;
        button.title = label;

        if (isCurrent) {
          button.setAttribute('aria-current', 'page');
        } else {
          button.addEventListener('click', () => this.navigateTo(node.id));
          this.makeCrumbDropTarget(button, node);
        }
        items.appendChild(button);

        if (!isCurrent) {
          const sep = document.createElement('span');
          sep.className = 'crumb-sep';
          sep.textContent = '›';
          items.appendChild(sep);
        }
      });

      this.els.backButton.disabled = path.length <= 1;
      this.els.backButton.dataset.parentId = path.length > 1 ? path[path.length - 2].id : '';
    }

    renderCards(items, searching) {
      const grid = this.grid;
      grid.textContent = '';

      const fragment = document.createDocumentFragment();
      items.forEach((node) => {
        fragment.appendChild(this.createCard(node, searching));
      });
      grid.appendChild(fragment);
    }

    createCard(node, searching) {
      const isFolder = !!node.children;
      const card = document.createElement('div');
      card.className = 'card ' + (isFolder ? 'folder' : 'bookmark');
      card.dataset.id = node.id;
      card.dataset.kind = isFolder ? 'folder' : 'bookmark';
      if (node.url) card.dataset.url = node.url;

      const title = node.title || (isFolder ? '未命名文件夹' : node.url || '未命名书签');
      card.title = node.url || title;

      const icon = document.createElement('span');
      icon.className = 'card-icon';

      if (isFolder) {
        icon.appendChild(buildFolderIcon());
      } else {
        const img = document.createElement('img');
        img.className = 'favicon';
        img.alt = '';
        img.decoding = 'async';
        img.src = FALLBACK_ICON;
        img.dataset.url = node.url;
        icon.appendChild(img);
      }
      card.appendChild(icon);

      const titleEl = document.createElement('span');
      titleEl.className = 'card-title';
      titleEl.textContent = title;
      card.appendChild(titleEl);

      if (isFolder) {
        const count = document.createElement('span');
        count.className = 'card-count';
        count.textContent = `(${(node.children || []).length})`;
        card.appendChild(count);
      } else if (searching) {
        // 搜索结果里标出所在位置：优先显示文件夹，若标题里已包含文件夹名则改显示域名
        const path = this.folderPath(node.parentId || '').map((item) => item.title || '根目录');
        const folderName = path.length ? path[path.length - 1] : '';
        card.title = `${path.join(' › ')}\n${node.url || ''}`;

        const redundant = folderName && title.includes(folderName);
        const label = redundant ? hostOf(node.url) : folderName;
        if (label) {
          const where = document.createElement('span');
          where.className = 'card-host';
          where.textContent = label;
          where.title = path.join(' › ');
          card.appendChild(where);
        }
      }

      if (!searching) card.draggable = true;

      return card;
    }

    updateStatus(count, searching) {
      const statusText = this.els.statusText;
      const statusCount = this.els.statusCount;
      if (!statusText || !statusCount) return;

      if (typeof count === 'number') this.lastCount = count;
      if (typeof searching === 'boolean') this.lastSearching = searching;

      if (this.lastSearching) {
        statusText.textContent = '搜索结果';
      } else {
        const folder = this.currentFolder;
        statusText.textContent = (folder && folder.title) || '根目录';
      }
      statusCount.textContent = `${this.lastCount || 0} 项`;
    }

    /* ---------------- 图标 ---------------- */

    loadIconCache() {
      try {
        const raw = localStorage.getItem(ICON_CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (error) {
        return {};
      }
    }

    flushIconCache() {
      clearTimeout(this.iconFlushTimer);
      this.iconFlushTimer = setTimeout(() => {
        try {
          localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(this.iconCache));
        } catch (error) {
          /* 存储已满时忽略 */
        }
      }, 600);
    }

    pruneIconCache() {
      const now = Date.now();
      let changed = false;
      Object.keys(this.iconCache).forEach((host) => {
        const entry = this.iconCache[host];
        if (!entry || !entry.ts || now - entry.ts > 30 * 24 * 3600 * 1000) {
          delete this.iconCache[host];
          changed = true;
        }
      });
      if (changed) this.flushIconCache();
    }

    prefetchIcons() {
      const images = this.grid.querySelectorAll('img.favicon[data-url]');
      images.forEach((img) => this.attachFavicon(img, img.dataset.url));
    }

    attachFavicon(img, url) {
      const host = hostOf(url);
      if (!host) {
        img.src = FALLBACK_ICON;
        return;
      }

      const cached = this.iconCache[host];
      const fresh = cached && Date.now() - cached.ts < ICON_TTL;
      if (fresh && cached.ok === false) {
        img.src = FALLBACK_ICON;
        return;
      }

      let protocol = 'https:';
      try {
        protocol = new URL(url).protocol;
      } catch (error) {
        img.src = FALLBACK_ICON;
        return;
      }

      const src = `${protocol}//${host}/favicon.ico`;

      img.addEventListener('load', () => {
        if (img.naturalWidth > 1) {
          this.iconCache[host] = { ok: true, ts: Date.now() };
          this.flushIconCache();
        }
      }, { once: true });

      img.addEventListener('error', () => {
        img.src = FALLBACK_ICON;
        this.iconCache[host] = { ok: false, ts: Date.now() };
        this.flushIconCache();
      }, { once: true });

      img.src = src;
    }

    /* ---------------- 导航 ---------------- */

    navigateTo(folderId) {
      if (!folderId || folderId === this.currentFolderId) return;
      this.currentFolderId = folderId;
      this.query = '';
      this.els.searchInput.value = '';
      this.els.searchClear.hidden = true;
      this.render();
      this.closeMenus();
    }

    goUp() {
      const path = this.folderPath(this.currentFolderId);
      if (path.length <= 1) return;
      this.navigateTo(path[path.length - 2].id);
    }

    async openBookmark(url) {
      if (!url) return;
      try {
        await browser.tabs.create({ url });
        // 自动关闭开启时，打开书签后立即收起窗口
        if (this.settings.autoClose) {
          window.close();
        }
      } catch (error) {
        console.error('[Bookmark] 打开书签失败:', error);
        this.toast('打开失败');
      }
    }

    async openSettings() {
      try {
        await browser.runtime.openOptionsPage();
      } catch (error) {
        console.error('[Bookmark] 打开设置失败:', error);
      }
    }

    async refresh() {
      this.toast('正在刷新…');
      await this.loadTree();
      if (!this.nodeMap.has(this.currentFolderId)) {
        this.currentFolderId = this.resolveStartFolder();
      }
      this.render();
      this.toast('已刷新');
    }

    /* ---------------- 搜索 ---------------- */

    searchResults() {
      const query = this.query.toLowerCase();
      if (!query) return [];
      return this.bookmarks
        .filter((node) => {
          const title = (node.title || '').toLowerCase();
          const url = (node.url || '').toLowerCase();
          return title.includes(query) || url.includes(query);
        })
        .slice(0, 300);
    }

    handleSearchInput(value) {
      this.els.searchClear.hidden = !value;
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.query = value.trim();
        this.render();
      }, 90);
    }

    clearSearch() {
      this.query = '';
      this.els.searchInput.value = '';
      this.els.searchClear.hidden = true;
      this.render();
      this.els.searchInput.focus();
    }

    /* ---------------- 事件绑定 ---------------- */

    bindEvents() {
      const els = this.els;

      els.searchInput.addEventListener('input', (event) => this.handleSearchInput(event.target.value));
      els.searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          this.clearSearch();
        }
      });
      els.searchClear.addEventListener('click', () => this.clearSearch());
      els.searchReset.addEventListener('click', () => this.clearSearch());

      els.menuBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleMainMenu();
      });

      els.backButton.addEventListener('click', () => this.goUp());

      // 状态栏「自动关闭」开关
      if (els.autoCloseInput) {
        els.autoCloseInput.addEventListener('change', () => {
          const enabled = els.autoCloseInput.checked;
          this.applyAutoClose(enabled);
          this.saveSettings({ autoClose: enabled });
          this.toast(enabled ? '打开书签后将自动关闭窗口' : '窗口会保持打开');
        });
      }

      this.bindGridEvents();
      this.bindMenuEvents();
      this.bindModalEvents();
      this.bindResizeEvents();
      this.bindKeyboard();

      els.scrollWrap.addEventListener('scroll', () => this.updateScrollHints(), true);
      this.grid.addEventListener('scroll', () => {
        // 自愈：没有拖拽却还有自动滚动在跑，说明状态泄漏，立即清理
        if (!this.dragState && this.autoScrollRaf) this.stopAutoScroll();
        this.updateScrollHints();
      });

      window.addEventListener('resize', () => {
        this.updateScrollHints();
      });

      document.addEventListener('click', (event) => {
        if (event.target.closest('.context-menu, .main-menu, .size-pop, #menuBtn')) return;
        this.closeMenus();
      });

      document.addEventListener('contextmenu', (event) => {
        if (!event.target.closest('.card')) {
          event.preventDefault();
          this.closeMenus();
        }
      });

      window.addEventListener('blur', () => this.closeMenus());

      browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync') this.handleSyncChanges(changes);
      });

      this.watchWindowResize();
    }

    handleSyncChanges(changes) {
      if (changes.themeMode) {
        this.applyTheme(changes.themeMode.newValue || 'auto');
      }
      if (changes.displayColumns) {
        this.applyColumns(changes.displayColumns.newValue || 'auto');
      }
      if (changes.showScrollbar) {
        this.applyScrollbarMode(changes.showScrollbar.newValue);
      }
      if (changes.autoClose) {
        this.applyAutoClose(changes.autoClose.newValue);
      }
      if (changes.sortMode) {
        this.settings.sortMode = changes.sortMode.newValue || 'folder-first';
        this.render();
      }
      if (changes.defaultFolderId && !this.query) {
        const next = changes.defaultFolderId.newValue;
        if (next && this.nodeMap.has(next)) {
          this.currentFolderId = next;
          this.render();
        }
      }
    }

    bindGridEvents() {
      const grid = this.grid;

      grid.addEventListener('click', (event) => {
        const card = event.target.closest('.card');
        if (!card) return;
        const node = this.nodeMap.get(card.dataset.id);
        if (!node) return;
        if (node.children) this.navigateTo(node.id);
        else this.openBookmark(node.url);
      });

      grid.addEventListener('contextmenu', (event) => {
        const card = event.target.closest('.card');
        if (!card) return;
        event.preventDefault();
        event.stopPropagation();
        const node = this.nodeMap.get(card.dataset.id);
        if (!node) return;
        this.showContextMenu(node, event.clientX, event.clientY);
      });

      grid.addEventListener('dragstart', (event) => {
        const card = event.target.closest('.card');
        if (!card || this.query) {
          event.preventDefault();
          return;
        }
        const node = this.nodeMap.get(card.dataset.id);
        if (!node) return;

        this.dragState = { id: node.id, kind: node.children ? 'folder' : 'bookmark' };
        card.classList.add('dragging');
        try {
          event.dataTransfer.setData('text/plain', node.id);
          event.dataTransfer.effectAllowed = 'move';
        } catch (error) {
          /* 忽略 */
        }
      });

      grid.addEventListener('dragover', (event) => {
        if (!this.dragState) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

        const card = event.target.closest('.card');
        this.clearDropMarks(card && card.dataset.id === this.dragState.id ? null : card);

        if (!card || card.dataset.id === this.dragState.id) {
          grid.classList.add('drag-over');
        }

        this.checkAutoScroll(event);
      });

      // 指针离开网格时立刻停掉自动滚动，避免计时器在网格外空转
      grid.addEventListener('dragleave', (event) => {
        if (!this.dragState) return;
        if (!grid.contains(event.relatedTarget)) {
          this.clearDropMarks();
          this.stopAutoScroll();
        }
      });

      grid.addEventListener('drop', (event) => {
        if (!this.dragState) return;
        event.preventDefault();
        const dragId = this.dragState.id;
        const card = event.target.closest('.card');
        const target = card && card.dataset.id !== dragId ? this.nodeMap.get(card.dataset.id) : null;

        this.clearDropMarks();
        this.endDrag();

        if (!target) {
          this.moveNode(dragId, this.currentFolderId, null, 'end');
        } else if (target.children) {
          this.moveNode(dragId, target.id, target, 'into');
        } else {
          this.moveNode(dragId, target.parentId, target, 'before');
        }
      });

      this.bindDragGuards();
    }

    /**
     * 拖拽收尾兜底。
     *
     * 卡滚动的根因：拖动落点后会调用 render() 重建整个网格，
     * 被拖的源元素随 DOM 一起被移除，grid 上的 dragend 因此不再触发，
     * 自动滚动还在跑（每帧改写 scrollTop），用户滚轮一滚就被拉回去，看起来像"卡死"。
     * 这里在 document 层补齐所有可能表示"拖拽已结束"的信号，确保一定收尾。
     */
    bindDragGuards() {
      const finish = () => {
        if (this.dragState || this.autoScrollRaf) this.endDrag();
      };

      // 延迟到当前事件处理完之后再收尾，避免抢在 grid 的 drop 之前把 dragState 清掉
      const finishLater = () => {
        setTimeout(finish, 0);
      };

      // dragend 是拖拽流程的最后一个事件，不会干扰 drop，捕获阶段安全
      document.addEventListener('dragend', finish, true);

      // drop / mouseup 必须用冒泡 + 延迟：
      // 捕获阶段会先于 grid 的 drop 处理器执行，导致排序逻辑拿不到 dragState 而失效
      document.addEventListener('drop', finishLater, false);
      document.addEventListener('mouseup', finishLater, false);

      window.addEventListener('blur', finish);
      window.addEventListener('beforeunload', () => this.stopAutoScroll());
      document.addEventListener('visibilitychange', finish);
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && (this.dragState || this.autoScrollRaf)) finish();
      }, true);
    }

    clearDropMarks(activeCard) {
      this.grid.querySelectorAll('.drop-into, .drop-before').forEach((el) => {
        el.classList.remove('drop-into', 'drop-before');
      });
      this.grid.classList.remove('drag-over');

      if (activeCard) {
        if (activeCard.dataset.kind === 'folder') activeCard.classList.add('drop-into');
        else activeCard.classList.add('drop-before');
      }
    }

    endDrag() {
      // 先停滚动，保证无论后续 DOM 是否还完整，计时器都已释放
      this.stopAutoScroll();
      this.dragState = null;
      if (!this.grid) return;
      this.grid.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
      this.clearDropMarks();
    }

    checkAutoScroll(event) {
      // 没有拖拽状态时绝不允许启动滚动
      if (!this.dragState) {
        this.stopAutoScroll();
        return;
      }

      const rect = this.grid.getBoundingClientRect();
      const zone = 48;
      const nearTop = event.clientY - rect.top < zone;
      const nearBottom = rect.bottom - event.clientY < zone;

      const max = this.grid.scrollHeight - this.grid.clientHeight;
      // 已经滚到顶/底就没有继续滚的必要，直接停，避免空转
      if (nearTop && this.grid.scrollTop <= 1) {
        this.stopAutoScroll();
        return;
      }
      if (nearBottom && this.grid.scrollTop >= max - 1) {
        this.stopAutoScroll();
        return;
      }

      if (nearTop) this.startAutoScroll(-1);
      else if (nearBottom) this.startAutoScroll(1);
      else this.stopAutoScroll();
    }

    startAutoScroll(direction) {
      this.autoScrollDirection = direction;

      if (this.autoScrollRaf) return;

      const step = () => {
        // 拖拽结束或方向被清空，立即释放帧回调
        if (!this.dragState || !this.autoScrollDirection || !this.grid) {
          this.stopAutoScroll();
          return;
        }

        const grid = this.grid;
        const max = Math.max(0, grid.scrollHeight - grid.clientHeight);
        const next = clamp(grid.scrollTop + this.autoScrollDirection * 8, 0, max);
        grid.scrollTop = next;

        // 贴边即停，不再占用动画帧
        if (next <= 0 || next >= max) {
          this.stopAutoScroll();
          return;
        }

        this.autoScrollRaf = requestAnimationFrame(step);
      };

      this.autoScrollRaf = requestAnimationFrame(step);
    }

    stopAutoScroll() {
      if (this.autoScrollRaf) {
        cancelAnimationFrame(this.autoScrollRaf);
        this.autoScrollRaf = null;
      }
      this.autoScrollDirection = 0;
      // 清理历史遗留的 interval（旧实现使用）
      if (this.autoScrollTimer) {
        clearInterval(this.autoScrollTimer);
        this.autoScrollTimer = null;
      }
    }

    async moveNode(dragId, parentId, target, mode) {
      if (!dragId || !parentId) return;
      if (dragId === parentId) return;
      if (target && this.isDescendant(dragId, target.id)) {
        this.toast('不能移动到自己的子文件夹');
        return;
      }

      const options = { parentId };
      if (mode === 'before' && target) {
        const siblings = this.nodeMap.get(parentId)?.children || [];
        let index = siblings.findIndex((item) => item.id === target.id);
        if (index < 0) index = siblings.length;
        const currentIndex = siblings.findIndex((item) => item.id === dragId);
        if (currentIndex >= 0 && currentIndex < index) index -= 1;
        options.index = Math.max(0, index);
      }

      try {
        await browser.bookmarks.move(dragId, options);
        await this.loadTree();
        this.render();
      } catch (error) {
        console.error('[Bookmark] 移动失败:', error);
        this.toast('移动失败');
      }
    }

    isDescendant(ancestorId, nodeId) {
      let node = this.nodeMap.get(nodeId);
      let guard = 0;
      while (node && node.parentId && guard < 100) {
        if (node.parentId === ancestorId) return true;
        node = this.nodeMap.get(node.parentId);
        guard += 1;
      }
      return false;
    }

    makeCrumbDropTarget(element, folder) {
      element.addEventListener('dragover', (event) => {
        if (!this.dragState) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.isDescendant(this.dragState.id, folder.id) || this.dragState.id === folder.id) return;
        element.classList.add('drag-target');
      });

      element.addEventListener('dragleave', () => {
        element.classList.remove('drag-target');
      });

      element.addEventListener('drop', async (event) => {
        if (!this.dragState) return;
        event.preventDefault();
        event.stopPropagation();
        element.classList.remove('drag-target');
        const dragId = this.dragState.id;
        this.endDrag();
        if (dragId === folder.id) return;
        if (this.isDescendant(dragId, folder.id)) {
          this.toast('不能移动到自己的子文件夹');
          return;
        }
        try {
          await browser.bookmarks.move(dragId, { parentId: folder.id });
          await this.loadTree();
          this.render();
        } catch (error) {
          console.error('[Bookmark] 移动失败:', error);
          this.toast('移动失败');
        }
      });
    }

    /* ---------------- 菜单 ---------------- */

    bindMenuEvents() {
      this.els.contextMenu.addEventListener('click', (event) => {
        const row = event.target.closest('.menu-row');
        if (!row) return;
        const action = row.dataset.action;
        const node = this.contextTarget;
        this.hideContextMenu();
        if (!node) return;

        if (action === 'open') {
          if (node.children) this.navigateTo(node.id);
          else this.openBookmark(node.url);
        } else if (action === 'edit') {
          this.openEditModal(node);
        } else if (action === 'copy') {
          this.copyLink(node.url);
        } else if (action === 'moveUp') {
          this.moveToParent(node);
        } else if (action === 'delete') {
          this.removeNode(node);
        }
      });

      this.els.mainMenu.addEventListener('click', (event) => {
        const row = event.target.closest('.menu-row');
        if (!row) return;
        const action = row.dataset.action;
        this.hideMainMenu();
        if (action === 'refresh') this.refresh();
        else if (action === 'size') this.openSizePop();
        else if (action === 'settings') this.openSettings();
      });
    }

    showContextMenu(node, x, y) {
      this.contextTarget = node;
      this.hideMainMenu();
      this.hideSizePop();

      const menu = this.els.contextMenu;
      const isFolder = !!node.children;
      menu.querySelector('[data-action="copy"]').hidden = isFolder;
      menu.querySelector('[data-action="open"] .menu-label').textContent = isFolder ? '打开文件夹' : '打开';
      menu.querySelector('[data-action="moveUp"]').disabled = this.folderPath(this.currentFolderId).length <= 1;

      menu.hidden = false;
      menu.style.left = '0px';
      menu.style.top = '0px';

      const rect = menu.getBoundingClientRect();
      const left = clamp(x, 6, window.innerWidth - rect.width - 6);
      const top = clamp(y, 6, window.innerHeight - rect.height - 6);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    }

    hideContextMenu() {
      this.els.contextMenu.hidden = true;
      this.contextTarget = null;
    }

    toggleMainMenu() {
      if (this.els.mainMenu.hidden) this.showMainMenu();
      else this.hideMainMenu();
    }

    showMainMenu() {
      this.hideContextMenu();
      this.hideSizePop();
      const menu = this.els.mainMenu;
      menu.hidden = false;
      menu.style.left = 'auto';
      menu.style.right = '10px';
      menu.style.top = '48px';
      menu.querySelector('[data-action="size"]').hidden = false;
      menu.querySelector('[data-action="window"]').hidden = true;
    }

    hideMainMenu() {
      this.els.mainMenu.hidden = true;
    }

    closeMenus() {
      this.hideContextMenu();
      this.hideMainMenu();
      this.hideSizePop();
    }

    /* ---------------- 窗口尺寸面板 ---------------- */

    openSizePop() {
      const pop = this.els.sizePop;
      pop.hidden = false;
      pop.style.right = '10px';
      pop.style.top = '48px';
      this.fillSizeFields();
    }

    /** 把当前窗口尺寸填进面板，并重建预设按钮 */
    fillSizeFields() {
      const limit = WINDOW_LIMIT;
      const els = this.els;

      els.sizePresets.textContent = '';
      SIZE_PRESETS.forEach((preset) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'preset';
        button.textContent = preset.label;
        button.dataset.w = String(preset.w);
        button.dataset.h = String(preset.h);
        button.addEventListener('click', () => {
          this.els.sizeW.value = preset.w;
          this.els.sizeH.value = preset.h;
          this.applySizeForm();
        });
        els.sizePresets.appendChild(button);
      });

      els.sizeW.min = String(limit.minW);
      els.sizeW.max = String(limit.maxW);
      els.sizeH.min = String(limit.minH);
      els.sizeH.max = String(limit.maxH);

      const current = this.windowSize || { w: limit.defaultW, h: limit.defaultH };
      els.sizeW.value = current.w;
      els.sizeH.value = current.h;
      els.sizeCurrent.textContent = `${current.w} × ${current.h}`;

      els.sizeTip.textContent =
        `窗口高度可到 ${limit.maxH}、宽度可到 ${limit.maxW}。应用后立即缩放当前窗口，尺寸会被记住。`;

      this.markActivePreset();
    }

    markActivePreset() {
      const w = Number(this.els.sizeW.value);
      const h = Number(this.els.sizeH.value);
      this.els.sizePresets.querySelectorAll('.preset').forEach((button) => {
        button.classList.toggle('active', Number(button.dataset.w) === w && Number(button.dataset.h) === h);
      });
    }

    /** 读取面板里的宽高 → 缩放当前窗口 */
    applySizeForm() {
      const els = this.els;
      const limit = WINDOW_LIMIT;
      const w = clamp(Math.round(Number(els.sizeW.value)) || limit.defaultW, limit.minW, limit.maxW);
      const h = clamp(Math.round(Number(els.sizeH.value)) || limit.defaultH, limit.minH, limit.maxH);
      els.sizeW.value = w;
      els.sizeH.value = h;
      els.sizeCurrent.textContent = `${w} × ${h}`;

      this.applyWindowSize({ w, h });
      this.markActivePreset();
    }

    hideSizePop() {
      this.els.sizePop.hidden = true;
    }

    /* ---------------- 应用窗口尺寸 ---------------- */

    closeIfPopup() {
      // 本扩展的页面始终运行在 allowScriptsToClose 的独立窗口里
      try {
        window.close();
      } catch (error) {
        /* 忽略 */
      }
    }

    async applyWindowSize(size) {
      const target = {
        w: clamp(Math.round(size.w), WINDOW_LIMIT.minW, WINDOW_LIMIT.maxW),
        h: clamp(Math.round(size.h), WINDOW_LIMIT.minH, WINDOW_LIMIT.maxH)
      };
      this.windowSize = target;

      try {
        await browser.storage.local.set({
          windowSize: { width: target.w, height: target.h }
        });
      } catch (error) {
        console.error('[Bookmark] 保存窗口尺寸失败:', error);
      }

      try {
        const win = await browser.windows.getCurrent();
        await browser.windows.update(win.id, {
          width: target.w,
          height: target.h,
          state: 'normal'
        });
        this.toast(`窗口已调整为 ${target.w} × ${target.h}`);
        this.hideSizePop();
      } catch (error) {
        console.error('[Bookmark] 调整窗口尺寸失败:', error);
        this.toast('调整窗口失败');
      }
    }

    bindResizeEvents() {
      const els = this.els;

      els.sizeW.addEventListener('input', () => {
        this.els.sizeCurrent.textContent = `${this.els.sizeW.value} × ${this.els.sizeH.value}`;
        this.markActivePreset();
      });
      els.sizeH.addEventListener('input', () => {
        this.els.sizeCurrent.textContent = `${this.els.sizeW.value} × ${this.els.sizeH.value}`;
        this.markActivePreset();
      });

      els.sizeApply.addEventListener('click', () => this.applySizeForm());
      els.sizeCancel.addEventListener('click', () => this.hideSizePop());
    }

    /* ---------------- 右键操作 ---------------- */

    openEditModal(node) {
      this.editTarget = node;
      const isFolder = !!node.children;
      this.els.editTitle.textContent = isFolder ? '编辑文件夹' : '编辑书签';
      this.els.urlField.hidden = isFolder;
      this.els.editName.value = node.title || '';
      this.els.editUrl.value = node.url || '';
      this.els.editOverlay.hidden = false;
      this.els.editName.focus();
      this.els.editName.select();
    }

    hideEditModal() {
      this.els.editOverlay.hidden = true;
      this.editTarget = null;
    }

    bindModalEvents() {
      const els = this.els;

      els.editCancel.addEventListener('click', () => this.hideEditModal());
      els.editSave.addEventListener('click', () => this.saveEdit());
      els.editOverlay.addEventListener('mousedown', (event) => {
        if (event.target === els.editOverlay) this.hideEditModal();
      });
      [els.editName, els.editUrl].forEach((input) => {
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.saveEdit();
          }
        });
      });

      els.confirmCancel.addEventListener('click', () => this.closeConfirm(false));
      els.confirmOk.addEventListener('click', () => this.closeConfirm(true));
      els.confirmOverlay.addEventListener('mousedown', (event) => {
        if (event.target === els.confirmOverlay) this.closeConfirm(false);
      });
    }

    async saveEdit() {
      const node = this.editTarget;
      if (!node) return;
      const title = this.els.editName.value.trim();
      if (!title) {
        this.toast('名称不能为空');
        return;
      }

      const updates = { title };
      if (!node.children) {
        const url = this.els.editUrl.value.trim();
        if (url) {
          try {
            new URL(url);
          } catch (error) {
            this.toast('网址格式不正确');
            return;
          }
          updates.url = url;
        }
      }

      try {
        await browser.bookmarks.update(node.id, updates);
        this.hideEditModal();
        await this.loadTree();
        this.render();
        this.toast('已保存');
      } catch (error) {
        console.error('[Bookmark] 保存失败:', error);
        this.toast('保存失败');
      }
    }

    confirm(title, text, okText) {
      const els = this.els;
      els.confirmTitle.textContent = title;
      els.confirmText.textContent = text;
      els.confirmOk.textContent = okText || '确定';
      els.confirmOverlay.hidden = false;
      return new Promise((resolve) => {
        this.confirmResolver = resolve;
        els.confirmOk.focus();
      });
    }

    closeConfirm(result) {
      this.els.confirmOverlay.hidden = true;
      const resolver = this.confirmResolver;
      this.confirmResolver = null;
      if (resolver) resolver(!!result);
    }

    async removeNode(node) {
      const isFolder = !!node.children;
      const name = node.title || (isFolder ? '未命名文件夹' : node.url);
      const detail = isFolder
        ? `“${name}” 及其中的 ${(node.children || []).length} 项内容会一起删除，且无法撤销。`
        : `“${name}” 会从书签中删除，且无法撤销。`;

      const ok = await this.confirm('删除书签', detail, '删除');
      if (!ok) return;

      try {
        if (isFolder) await browser.bookmarks.removeTree(node.id);
        else await browser.bookmarks.remove(node.id);
        if (this.currentFolderId === node.id) this.currentFolderId = this.resolveStartFolder();
        await this.loadTree();
        this.render();
        this.toast('已删除');
      } catch (error) {
        console.error('[Bookmark] 删除失败:', error);
        this.toast('删除失败');
      }
    }

    async moveToParent(node) {
      const folder = this.currentFolder;
      if (!folder || !folder.parentId) {
        this.toast('已经在根目录了');
        return;
      }
      try {
        await browser.bookmarks.move(node.id, { parentId: folder.parentId });
        await this.loadTree();
        this.render();
        this.toast('已移到上级文件夹');
      } catch (error) {
        console.error('[Bookmark] 移动失败:', error);
        this.toast('移动失败');
      }
    }

    async copyLink(url) {
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        this.toast('链接已复制');
      } catch (error) {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          this.toast('链接已复制');
        } catch (fallbackError) {
          this.toast('复制失败');
        }
        textarea.remove();
      }
    }

    /* ---------------- 滚动提示 / 键盘 ---------------- */

    updateScrollHints() {
      const grid = this.grid;
      const wrap = this.wrap;
      if (!grid || !wrap) return;
      const max = grid.scrollHeight - grid.clientHeight;
      const top = grid.scrollTop;
      wrap.classList.toggle('can-up', max > 4 && top > 4);
      wrap.classList.toggle('can-down', max > 4 && top < max - 4);

      const hint = this.els.statusScrollHint;
      if (hint) {
        const gridRect = grid.getBoundingClientRect();
        let below = 0;
        for (const card of grid.children) {
          if (card.getBoundingClientRect().top >= gridRect.bottom - 2) below += 1;
        }
        hint.hidden = below === 0;
        if (below > 0) hint.textContent = `下方还有 ${below} 项`;
      }
    }

    bindKeyboard() {
      document.addEventListener('keydown', (event) => {
        const inField = event.target.matches('input, textarea, select');
        const anyOverlay = !this.els.editOverlay.hidden || !this.els.confirmOverlay.hidden;

        if (event.key === 'Escape') {
          if (anyOverlay) {
            if (!this.els.confirmOverlay.hidden) this.closeConfirm(false);
            else this.hideEditModal();
            event.preventDefault();
            return;
          }
          if (!this.els.contextMenu.hidden || !this.els.mainMenu.hidden || !this.els.sizePop.hidden) {
            this.closeMenus();
            event.preventDefault();
            return;
          }
          if (this.query) {
            this.clearSearch();
            event.preventDefault();
            return;
          }
          this.closeIfPopup();
          return;
        }

        if (inField || anyOverlay) return;

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          this.els.searchInput.focus();
          this.els.searchInput.select();
          return;
        }

        if (event.key === '/' || event.key === 'F3') {
          event.preventDefault();
          this.els.searchInput.focus();
          return;
        }

        if (event.altKey && event.key === 'ArrowLeft') {
          event.preventDefault();
          this.goUp();
          return;
        }

        if (event.key === 'Backspace' && !this.query) {
          event.preventDefault();
          this.goUp();
        }
      });
    }

    /* ---------------- 提示 ---------------- */

    toast(message) {
      const el = this.els.toast;
      if (!el) return;
      el.textContent = message;
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add('show'));
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => { el.hidden = true; }, 200);
      }, 1600);
    }
  }

  const app = new BookmarkApp();
  app.init().catch((error) => {
    console.error('[Bookmark] 初始化失败:', error);
    const grid = document.getElementById('bookmarkGrid');
    if (grid) {
      const box = document.createElement('div');
      box.style.cssText = 'padding:24px;color:#ff6b81;font-size:12px;line-height:1.6';
      box.textContent = '初始化失败：' + (error && error.message ? error.message : String(error));
      grid.textContent = '';
      grid.appendChild(box);
    }
  });
})();
