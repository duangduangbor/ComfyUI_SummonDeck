/**
 * 怪兽牌组 —— 大图查看（lightbox）
 *
 * 补图面板里的缩略图只有 4:5 一小块，脸和配饰根本看不清；
 * 用户要判断"这张侧面能不能用"，必须能放大看。
 *
 * 用法：
 *   openLightbox([{ src, title, sub }], 起始下标)
 *
 * 交互：
 *   点背景 / ✕ / Esc —— 关闭
 *   ← →             —— 切换（同一组图之间）
 *   点图片          —— 1:1 实际像素 ↔ 适应窗口
 *
 * 为什么键位监听挂在 window 的捕获阶段：
 *   补图面板自己在 document 捕获阶段监听 Esc（要拦"跑着的时候别关"）。
 *   同一节点上的捕获监听按注册顺序执行，晚注册的收不到已 stopPropagation 的事件 ——
 *   挂在更外层的 window 才能先一步吃掉 Esc，不然看大图按 Esc 会把整个面板关掉。
 */

import { el } from "./cw-core.js";

let host = null;
let keyHandler = null;

export function isLightboxOpen() {
  return !!host;
}

export function closeLightbox() {
  if (keyHandler) {
    window.removeEventListener("keydown", keyHandler, true);
    keyHandler = null;
  }
  if (host) host.remove();
  host = null;
}

/**
 * @param {Array<{src:string,title?:string,sub?:string}>} items
 * @param {number} index 起始下标
 */
export function openLightbox(items, index = 0) {
  const list = (Array.isArray(items) ? items : [items]).filter((it) => it && it.src);
  if (!list.length) return;

  // 只留一层：连点两张缩略图不该叠出两层遮罩
  closeLightbox();

  let at = Math.min(Math.max(0, Number(index) | 0), list.length - 1);
  let actual = false;

  const img = el("img", { class: "cw-lb-img", alt: "", draggable: "false" });
  const titleEl = el("div", { class: "cw-lb-title" });
  const subEl = el("div", { class: "cw-lb-sub" });
  const counter = el("div", { class: "cw-lb-counter" });
  const stage = el("div", { class: "cw-lb-stage is-loading" }, [img]);

  const prevBtn = el("button", {
    class: "cw-lb-nav is-prev",
    type: "button",
    text: "‹",
    title: "上一张（←）",
  });
  const nextBtn = el("button", {
    class: "cw-lb-nav is-next",
    type: "button",
    text: "›",
    title: "下一张（→）",
  });
  const zoomBtn = el("button", {
    class: "cw-lb-tool",
    type: "button",
    text: "1:1",
    title: "按实际像素查看（看图时点一下图片也行）",
  });
  const tabBtn = el("button", {
    class: "cw-lb-tool",
    type: "button",
    text: "新标签打开",
    title: "在浏览器里打开原图",
  });
  const closeBtn = el("button", {
    class: "cw-lb-close",
    type: "button",
    text: "✕",
    title: "关闭（Esc）",
  });

  const panel = el("div", { class: "cw-lb" }, [
    el("div", { class: "cw-lb-head" }, [
      el("div", { class: "cw-lb-caption" }, [titleEl, subEl]),
      el("div", { class: "cw-lb-tools" }, [counter, zoomBtn, tabBtn, closeBtn]),
    ]),
    stage,
    el("div", {
      class: "cw-lb-hint",
      text: "← → 切换 · Esc 关闭 · 点图片看实际像素",
    }),
  ]);

  const mask = el("div", { class: "cw-lb-mask" }, [prevBtn, panel, nextBtn]);
  host = mask;
  // 挂在补图面板/卡库的 .cw-shell 里，能继承它的主题；没有就挂 body
  const shell = document.querySelector(".cw-shell");
  (shell || document.body).append(mask);

  /* ---------- 渲染 ---------- */

  const setActual = (on) => {
    actual = on;
    stage.classList.toggle("is-actual", on);
    zoomBtn.classList.toggle("is-on", on);
    zoomBtn.textContent = on ? "适应窗口" : "1:1";
    if (!on) stage.scrollTo(0, 0);
  };

  const apply = () => {
    const it = list[at] || {};
    img.src = it.src;
    img.alt = it.title || "";
    titleEl.textContent = it.title || "";
    subEl.textContent = it.sub || "";
    subEl.style.display = it.sub ? "" : "none";

    counter.textContent = list.length > 1 ? `${at + 1} / ${list.length}` : "";
    counter.style.display = list.length > 1 ? "" : "none";
    prevBtn.style.display = nextBtn.style.display = list.length > 1 ? "" : "none";
    prevBtn.disabled = at === 0;
    nextBtn.disabled = at === list.length - 1;

    stage.classList.add("is-loading");
    setActual(false);
  };

  const go = (delta) => {
    const next = at + delta;
    if (next < 0 || next >= list.length) return;
    at = next;
    apply();
  };

  /* ---------- 事件 ---------- */

  img.addEventListener("load", () => stage.classList.remove("is-loading"));
  img.addEventListener("error", () => {
    stage.classList.remove("is-loading");
    titleEl.textContent = "这张图读不出来";
  });
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    setActual(!actual);
  });

  // 点背景关：面板和左右按钮各自拦住，避免"想翻页结果关了"
  mask.addEventListener("click", (e) => {
    if (e.target === mask) closeLightbox();
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  prevBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    go(-1);
  });
  nextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    go(1);
  });
  zoomBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setActual(!actual);
  });
  tabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const it = list[at];
    if (it?.src) window.open(it.src, "_blank", "noopener");
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLightbox();
  });

  keyHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeLightbox();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      go(-1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      go(1);
      return;
    }
    // 空格 / 回车也切 1:1，看图时手不想离开键盘
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      setActual(!actual);
    }
  };
  window.addEventListener("keydown", keyHandler, true);

  apply();
}
