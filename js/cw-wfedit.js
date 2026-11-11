/**
 * 怪兽牌组 —— 预设工作流编辑器
 *
 * 做法：把预设的 UI 画布直接载进当前 ComfyUI 画布，你改节点、换 LoRA、
 * 调步数，再存回插件。存回之后补图立刻用新版本，不用重启。
 *
 * 两个必须守住的东西：
 *
 * 1. **进编辑器前先给当前画布拍快照**。载入预设会覆盖你正在做的事情，
 *    这跟"点错一个按钮丢掉两小时"只差一次误操作。快照存 localStorage，
 *    退出编辑器时自动还原。
 *
 * 2. **保存前先过一遍后端校验**。一份存进去却跑不起来的画布，
 *    比不让存更糟 —— 用户要等到补图失败才发现。
 */

import { app } from "../../scripts/app.js";
import { cwApi, el, isDarkTheme, toast } from "./cw-core.js";

const SNAP_KEY = "cw_canvas_backup_v1";

let barEl = null;
let editing = null; // { presetId, label, snapshot }

/* -------------------------------------------------------------------------
   画布快照
   ------------------------------------------------------------------------- */

function snapshotCanvas() {
  try {
    const data = app.graph?.serialize?.();
    if (!data) return false;
    localStorage.setItem(SNAP_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.warn("[怪兽牌组] 画布快照失败", e);
    return false;
  }
}

function hasSnapshot() {
  try {
    return !!localStorage.getItem(SNAP_KEY);
  } catch (e) {
    return false;
  }
}

async function restoreSnapshot() {
  let raw = null;
  try {
    raw = localStorage.getItem(SNAP_KEY);
  } catch (e) {
    raw = null;
  }
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    await app.loadGraphData(data);
    localStorage.removeItem(SNAP_KEY);
    return true;
  } catch (e) {
    console.warn("[怪兽牌组] 画布还原失败", e);
    return false;
  }
}

/* -------------------------------------------------------------------------
   顶部状态条
   ------------------------------------------------------------------------- */

function buildBar() {
  const titleEl = el("b", { text: "" });
  const subEl = el("span", { class: "cw-wfe-sub" });

  const saveBtn = el("button", { class: "cw-wfe-btn is-primary", type: "button", text: "保存" });
  const resetBtn = el("button", { class: "cw-wfe-btn", type: "button", text: "恢复内置" });
  const backBtn = el("button", { class: "cw-wfe-btn", type: "button", text: "保存并返回" });

  const bar = el("div", { class: "cw-wfe-bar" }, [
    el("div", { class: "cw-wfe-left" }, [
      el("span", { class: "cw-wfe-dot" }),
      titleEl,
      subEl,
    ]),
    el("div", { class: "cw-wfe-right" }, [resetBtn, saveBtn, backBtn]),
  ]);
  if (isDarkTheme()) bar.classList.add("cw-dark");

  saveBtn.addEventListener("click", async () => {
    await saveCurrent({ restore: false, silent: false });
  });

  backBtn.addEventListener("click", async () => {
    const done = await saveCurrent({ restore: true, silent: true });
    if (!done) return;
    await closeEditor(false);
  });

  resetBtn.addEventListener("click", async () => {
    if (!editing) return;
    const ok = window.confirm(
      "把画布恢复成内置版本？你在画布上改的内容会丢掉。\n（卡片的图片和数据不受影响）"
    );
    if (!ok) return;
    try {
      const meta = await cwApi.presetReset(editing.presetId);
      const { ui } = await cwApi.presetGet(editing.presetId);
      await app.loadGraphData(ui);
      subEl.textContent = `已恢复内置 · ${meta.nodes} 个节点`;
      toast("已恢复内置工作流");
    } catch (e) {
      toast(`恢复失败：${e.message}`);
    }
  });

  return { bar, titleEl, subEl };
}

function mountBar(label) {
  unmountBar();
  const { bar, titleEl, subEl } = buildBar();
  titleEl.textContent = `正在编辑预设：${label}`;
  subEl.textContent = "保存后补图立刻生效 · 返回会自动还原你原来的画布";
  document.body.append(bar);
  barEl = bar;
}

function unmountBar() {
  if (barEl) {
    barEl.remove();
    barEl = null;
  }
}

/* -------------------------------------------------------------------------
   核心动作
   ------------------------------------------------------------------------- */

async function saveCurrent({ restore = false, silent = false } = {}) {
  if (!editing) return false;

  let ui;
  try {
    ui = app.graph.serialize();
  } catch (e) {
    toast("读不到画布");
    return false;
  }

  try {
    await cwApi.presetValidate(ui);
    const meta = await cwApi.presetSave(editing.presetId, ui);
    if (!silent) toast(`已保存 · ${meta.nodes} 个节点可执行`);
    if (restore) await restoreSnapshot();
    return true;
  } catch (e) {
    toast(`保存失败：${e.message}`);
    return false;
  }
}

export async function openPresetEditor(presetId, label) {
  if (editing) {
    toast("已经在编辑另一个预设了，先返回");
    return;
  }

  const backed = snapshotCanvas();
  if (!backed) {
    const go = window.confirm(
      "没能备份你当前的画布。继续的话，载入预设会覆盖它。\n确定继续？"
    );
    if (!go) return;
  }

  try {
    const { ui, meta } = await cwApi.presetGet(presetId);
    await app.loadGraphData(ui);
    editing = { presetId, label: label || presetId, snapshot: backed };
    mountBar(label || presetId);
    if (meta?.edited) toast("这份是改过的版本");
  } catch (e) {
    toast(`载入失败：${e.message}`);
    // 载入失败也要把画布还回去，否则用户就卡在半路
    if (backed) await restoreSnapshot();
  }
}

export async function closeEditor(ask = true) {
  if (!editing) return;
  if (ask) {
    const ok = window.confirm("返回会还原你原来的画布，画布上未保存的改动会丢掉。继续？");
    if (!ok) return;
  }
  if (editing.snapshot) {
    const restored = await restoreSnapshot();
    if (!restored && hasSnapshot()) toast("原画布还原失败，快照还在 localStorage 里");
  }
  editing = null;
  unmountBar();
}

export function isEditingPreset() {
  return !!editing;
}

export function editingPresetId() {
  return editing?.presetId || "";
}
