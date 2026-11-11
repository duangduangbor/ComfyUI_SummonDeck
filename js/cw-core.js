/**
 * 怪兽牌组 —— 核心：接口封装、全局状态、工具
 *
 * 状态模型：
 *   - 工作台（哪些卡在台上）是**全局**的，所有工作台节点共享同一份
 *   - 提示词是**每个节点各自**的，一次创作一份
 */

import { api } from "../../scripts/api.js";

const PREFIX = "/character_workbench";

/* -------------------------------------------------------------------------
   接口
   ------------------------------------------------------------------------- */

async function req(path, options = {}) {
  const res = await api.fetchApi(PREFIX + path, options);
  let payload = null;
  try {
    payload = await res.json();
  } catch (e) {
    throw new Error(`接口返回异常 (${res.status})`);
  }
  if (!payload || payload.ok !== true) {
    throw new Error((payload && payload.error) || `请求失败 (${res.status})`);
  }
  return payload.data;
}

const json = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});

export const cwApi = {
  getLibrary: () => req("/library"),
  createCard: (body) => req("/card/create", json(body)),
  updateCard: (id, body) => req("/card/update", json({ id, ...body })),
  deleteCard: (id) => req("/card/delete", json({ id })),
  setWorkbench: (ids) => req("/workbench", json({ ids })),

  addCategory: (body) => req("/category/add", json(body)),
  updateCategory: (id, body) => req("/category/update", json({ id, ...body })),
  deleteCategory: (id) => req("/category/delete", json({ id })),

  addQuick: (body) => req("/quick/add", json(body)),
  updateQuick: (id, body) => req("/quick/update", json({ id, ...body })),
  deleteQuick: (id) => req("/quick/delete", json({ id })),

  saveSettings: (body) => req("/settings", json(body)),
  deleteExtra: (id, file) => req("/extra/delete", json({ id, file })),
  clearAssets: (id) => req("/asset/delete", json({ id })),

  async upload(file, { cardId, slot = "main", name, view, label, source } = {}) {
    const form = new FormData();
    form.append("file", file, file.name);
    if (cardId) form.append("cardId", cardId);
    if (name) form.append("name", name);
    form.append("slot", slot);
    // 补图要记「这是哪个角度、从哪来的」，否则面板里没法按角度去重
    if (view) form.append("view", view);
    if (label) form.append("label", label);
    if (source) form.append("source", source);
    return req("/upload", { method: "POST", body: form });
  },

  // ---- 补图 ----
  supplementPresets: () => req("/supplement/presets"),
  supplementRefresh: () => req("/supplement/refresh", json({})),
  supplementRun: (body) => req("/supplement/run", json(body)),
  supplementJob: (id) => req(`/supplement/job?id=${encodeURIComponent(id)}`),
  supplementActive: (cardId) => req(`/supplement/active?cardId=${encodeURIComponent(cardId)}`),
  supplementRerun: (body) => req("/supplement/rerun", json(body)),
  supplementCancel: (id) => req("/supplement/cancel", json({ id })),
  supplementPromptPreview: (body) => req("/supplement/prompt-preview", json(body)),
  cardOrphans: (id) => req("/card/orphans", json({ id })),
  cardPrune: (id) => req("/card/prune", json({ id })),

  // ---- 底稿生成 ----
  coverGenerate: (body) => req("/cover/generate", json(body)),

  // ---- 预设工作流（画布编辑 / 保存 / 重置）----
  presetGet: (id) => req(`/preset/get?id=${encodeURIComponent(id)}`),
  presetMeta: (id) => req(`/preset/meta?id=${encodeURIComponent(id)}`),
  presetSave: (id, ui) => req("/preset/save", json({ id, ui })),
  presetReset: (id) => req("/preset/reset", json({ id })),
  presetValidate: (ui) => req("/preset/validate", json({ ui })),
};

/* -------------------------------------------------------------------------
   资源 URL
   ------------------------------------------------------------------------- */

export function assetUrl(rel, bust) {
  if (!rel) return "";
  const raw = `${PREFIX}/asset?path=${encodeURIComponent(rel)}`;
  let url = raw;
  if (api && typeof api.apiURL === "function") {
    try {
      url = api.apiURL(raw);
    } catch (e) {
      url = raw;
    }
  }
  return bust ? `${url}${url.includes("?") ? "&" : "?"}t=${bust}` : url;
}

/* -------------------------------------------------------------------------
   全局状态
   ------------------------------------------------------------------------- */

class Store {
  constructor() {
    this.lib = null;
    this.loading = null;
    this.listeners = new Set();
    this._bust = {};
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind = "all") {
    for (const fn of this.listeners) {
      try {
        fn(kind);
      } catch (e) {
        console.error("[怪兽牌组] 监听器出错", e);
      }
    }
  }

  get categories() {
    return this.lib?.categories || [];
  }

  get cards() {
    return this.lib?.cards || [];
  }

  get quickButtons() {
    return this.lib?.quickButtons || [];
  }

  get settings() {
    return this.lib?.settings || { refTemplate: "image {n}", maxMegapixel: 1 };
  }

  get workbenchIds() {
    return this.lib?.workbench || [];
  }

  get stagedCards() {
    if (!this.lib) return [];
    const byId = new Map(this.cards.map((c) => [c.id, c]));
    return this.workbenchIds.map((id) => byId.get(id)).filter(Boolean);
  }

  card(id) {
    return this.cards.find((c) => c.id === id) || null;
  }

  categoryName(id) {
    return this.categories.find((c) => c.id === id)?.name || "未分类";
  }

  /** 图片被换过之后用它破缓存 */
  bust(id) {
    this._bust[id] = Date.now();
    return this._bust[id];
  }

  bustOf(id) {
    return this._bust[id] || 0;
  }

  async load(force = false) {
    if (this.lib && !force) return this.lib;
    if (this.loading) return this.loading;
    this.loading = cwApi
      .getLibrary()
      .then((lib) => {
        this.lib = lib;
        this.emit("load");
        return lib;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async refresh() {
    this.lib = await cwApi.getLibrary();
    this.emit("load");
    return this.lib;
  }

  /* ---- 工作台 ---- */

  isStaged(id) {
    return this.workbenchIds.includes(id);
  }

  async stage(id) {
    if (this.isStaged(id)) return;
    const ids = [...this.workbenchIds, id];
    this.lib.workbench = ids;
    this.emit("workbench");
    await cwApi.setWorkbench(ids);
  }

  async unstage(id) {
    const ids = this.workbenchIds.filter((x) => x !== id);
    this.lib.workbench = ids;
    this.emit("workbench");
    await cwApi.setWorkbench(ids);
  }

  async toggleStage(id) {
    return this.isStaged(id) ? this.unstage(id) : this.stage(id);
  }

  async setStage(ids) {
    this.lib.workbench = ids;
    this.emit("workbench");
    await cwApi.setWorkbench(ids);
  }

  /* ---- 卡的标记色 ---- */

  /** 空字符串 = 不标记。先改本地再落盘，失败了回滚。 */
  async setCardColor(id, color) {
    const card = this.card(id);
    if (!card) return;
    const prev = card.color || "";
    card.color = color || "";
    this.emit("cards");
    try {
      await cwApi.updateCard(id, { color: card.color });
    } catch (e) {
      card.color = prev;
      this.emit("cards");
      throw e;
    }
  }
}

export const store = new Store();

/* -------------------------------------------------------------------------
   工具
   ------------------------------------------------------------------------- */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function isDarkTheme() {
  const root = document.documentElement;
  const body = document.body;
  if (root.classList.contains("dark") || body.classList.contains("dark")) return true;
  if (body.classList.contains("dark-theme") || root.classList.contains("dark-theme")) return true;

  for (const node of [body, root]) {
    const bg = getComputedStyle(node).backgroundColor;
    const nums = bg.match(/[\d.]+/g);
    if (nums && nums.length >= 3) {
      const alpha = nums.length >= 4 ? parseFloat(nums[3]) : 1;
      if (alpha < 0.1) continue;
      const [r, g, b] = nums.map(Number);
      return 0.299 * r + 0.587 * g + 0.114 * b < 132;
    }
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

let toastTimer = null;

export function toast(message) {
  document.querySelector(".cw-toast")?.remove();
  const node = el("div", { class: "cw-toast", text: message });
  document.body.append(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2100);
}

export function debounce(fn, wait = 350) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/* 样式表只注入一次 */

let styleInjected = false;

export function injectStyle() {
  if (styleInjected) return;
  styleInjected = true;
  let href;
  try {
    // v 参数用于让浏览器更新样式表缓存，改样式时记得改这个号。
    // 路径从 import.meta.url 推 —— 插件目录以后改名不用再动这里。
    href = new URL("./style.css?v=1.3.1", import.meta.url).href;
  } catch (e) {
    href = "/extensions/ComfyUI_SummonDeck/style.css?v=1.3.1";
  }
  if (document.querySelector(`link[data-cw-style="1"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.cwStyle = "1";
  document.head.append(link);
}
