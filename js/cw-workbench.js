/**
 * 怪兽牌组 —— 节点内创作台
 *
 * 这里是唯一有 @ 交互的地方，而 @ 只认「台上的卡」。
 * 台上没卡就什么都 @ 不到 —— 这正是要的效果。
 */

import { app } from "../../scripts/app.js";
import { store, el, injectStyle, assetUrl, isDarkTheme, toast } from "./cw-core.js";
import { openLibrary } from "./cw-library.js";

const NODE_CLASS = "CharacterWorkbench";
const DEFAULT_SIZE = [452, 470];

/**
 * DOM 组件的「最小高度」必须是一个常量，绝不能反过来读 node.size。
 *
 * 曾经踩过的坑：写成 getMinHeight = () => node.size[1] - OFFSET，
 * 意思是「内容区跟着节点长」。但布局规则是
 *     节点高 = OFFSET实际 + 内容区高(最小)
 * 一旦 OFFSET 常量和实际布局对不上，就成了正反馈：
 *     节点高 → 内容区高 → 更大的节点高 → ……
 * 表现就是节点自己无限向上/下伸长（曾实测每秒 +200px，一路长到 2000+，
 * 加输出口、换前端版本都会重新触发）。
 *
 * 现在改成固定常量：节点高度由用户决定，内容区通过 CSS height:100% 填满宿主，
 * 两者彻底解耦，不管加多少输出口、宽度拉到多窄都不会再长。
 */
const MIN_CONTENT_HEIGHT = 300;

/** 超过这个高度就认为是坏数据，加载时拉回默认尺寸 */
const MAX_NODE_HEIGHT = 1600;

/** 工作台卡的标记色（和节点主题色系接近，深色浅色下都看得清） */
const MARK_COLORS = [
  "#d9534f", "#e08b3c", "#c9a227", "#5aa469",
  "#3f8ad4", "#7a6ad4", "#c060a1", "#e2e2e2",
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* -------------------------------------------------------------------------
   节点内 UI
   ------------------------------------------------------------------------- */

class WorkbenchUI {
  constructor(node, container) {
    this.node = node;
    this.container = container;
    this.prompt = "";
    this.suggestIndex = 0;
    this.suggestions = [];

    container.className = "cw-node";
    this.build();
    this.bindStore();

    this.dispose = () => {
      this.unsub?.();
      this.unsubTheme?.();
      this.ro?.disconnect();
      this.suggestEl.remove();
      this.colorPop?.remove();
    };
  }

  /* ---------- 结构 ---------- */

  build() {
    this.countEl = el("span", { class: "cw-node-count", text: "台上 0 张" });

    this.stageEl = el("div", { class: "cw-stage" });

    this.ta = el("textarea", {
      class: "cw-prompt",
      placeholder: "写提示词。打 @ 引用台上的卡，例如：@阿离 站在 @雨夜街头 的路灯下",
      spellcheck: "false",
    });

    // 提示词的高亮层：textarea 的文字设成透明，真正显示的是下面这层带颜色的文本。
    // 这样 @引用 才能按台上的标记色上色，而输入/选词/输入法行为仍然由原生 textarea 负责。
    this.hl = el("div", { class: "cw-hl", "aria-hidden": "true" });

    this.suggestEl = el("div", { class: "cw-suggest", hidden: true });
    this.suggestEl.hidden = true;

    this.quickEl = el("div", { class: "cw-quick" });

    this.headEl = el("div", { class: "cw-node-head" }, [
      this.countEl,
      el("button", {
        class: "cw-btn cw-btn-accent",
        text: "角色库 ▸",
        title: "打开角色库，选卡上台",
        onclick: () => this.openLibrary(),
      }),
    ]);

    this.container.replaceChildren(
      this.headEl,
      this.stageEl,
      el("div", { class: "cw-prompt-wrap" }, [this.hl, this.ta]),
      this.quickEl
    );

    // 候选框挂在 body 上：节点有 overflow:hidden，放里面会被裁掉
    document.body.append(this.suggestEl);
    // 调色板同理，挂在 body 上才不会被子节点裁掉
    this.colorPop = el("div", { class: "cw-color-pop", hidden: true });
    this.colorPop.hidden = true;
    document.body.append(this.colorPop);

    this.ta.addEventListener("input", () => {
      this.prompt = this.ta.value;
      this.pushPayload();
      this.syncHighlight();
      this.updateSuggest();
    });

    this.ta.addEventListener("scroll", () => this.syncScroll());
    // 节点被拉宽/缩窄、缩放画布时，换行位置会变，高亮层要重新对齐
    this.ro = new ResizeObserver(() => this.syncHighlight());
    this.ro.observe(this.ta);
    this.ta.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.ta.addEventListener("blur", () => {
      // 给点击候选留出时间
      setTimeout(() => this.hideSuggest(), 140);
    });
  }

  /* ---------- 状态 ---------- */

  bindStore() {
    this.unsub = store.subscribe((kind) => {
      if (
        kind === "workbench" ||
        kind === "cards" ||
        kind === "all" ||
        kind === "load"
      ) {
        this.renderStage();
        this.syncHighlight();
      }
      if (kind === "quick" || kind === "all" || kind === "load") this.renderQuick();
    });

    // 切换 ComfyUI 主题时补一下候选框底色
    this.themeObserver = new MutationObserver(() => this.applyTheme());
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
    this.unsubTheme = () => this.themeObserver.disconnect();

    this.renderStage();
    this.renderQuick();
    this.applyTheme();
  }

  applyTheme() {
    const dark = isDarkTheme();
    const pop = dark ? "#26272b" : "#ffffff";
    this.suggestEl.style.setProperty("--cw-pop-bg", pop);
    this.colorPop?.style.setProperty("--cw-pop-bg", pop);
    this.colorPop?.classList.toggle("cw-pop-dark", dark);
    // caret-color 要按主题选，否则深色下看不见光标
    this.container.classList.toggle("cw-dark", dark);
  }

  async ensureLibrary() {
    if (store.lib) return;
    try {
      await store.load(true);
    } catch (e) {
      console.error("[怪兽牌组] 读取卡片库失败", e);
    }
    this.renderStage();
    this.renderQuick();
  }

  /* ---------- 工作台 ---------- */

  renderStage() {
    const staged = store.stagedCards;
    this.countEl.textContent = staged.length ? `台上 ${staged.length} 张` : "台上没卡";

    if (!staged.length) {
      this.stageEl.replaceChildren(
        el("button", {
          class: "cw-stage-empty",
          text: "工作台是空的 · 点这里去拿卡",
          onclick: () => this.openLibrary(),
        })
      );
      return;
    }

    const chips = staged.map((card) => {
      // 只有身份锚定/可变项才算「会随图送出去」，详细设定默认不送
      const hasDesc = !!(card.identity || card.variable) && card.descOn !== false;
      const chip = el("div", {
        class: "cw-chip",
        title: `${card.name} · 提示词里打 @${card.name}${hasDesc ? "（会连同角色设定一起送给模型）" : ""}`,
        dataset: { color: card.color ? "1" : "0" },
        style: card.color ? `--cw-mark:${card.color}` : null,
        onclick: () => this.insertText(`@${card.name} `),
      });
      if (card.thumb || card.main) {
        chip.append(
          el("img", {
            src: assetUrl(card.thumb || card.main, store.bustOf(card.id)),
            alt: "",
          })
        );
      }
      chip.append(el("span", { class: "cw-chip-name", text: card.name || "?" }));
      if (hasDesc) {
        chip.append(el("i", { class: "cw-chip-desc" }));
      }
      // 颜色标记：小圆点，点开调色板
      chip.append(
        el("button", {
          class: "cw-chip-dot",
          title: "标记颜色",
          style: card.color ? `background:${card.color}` : null,
          onclick: (e) => {
            e.stopPropagation();
            this.openColorPop(card, e.currentTarget);
          },
        })
      );
      chip.append(
        el("button", {
          class: "cw-chip-x",
          text: "×",
          title: "下台",
          onclick: async (e) => {
            e.stopPropagation();
            await store.unstage(card.id);
          },
        })
      );
      return chip;
    });

    this.stageEl.replaceChildren(...chips);
    this.syncHighlight();
  }

  /* ---------- 标记色 ---------- */

  openColorPop(card, anchor) {
    const pop = this.colorPop;
    const pick = async (color) => {
      this.hideColorPop();
      try {
        await store.setCardColor(card.id, color);
      } catch (e) {
        toast(`改色失败：${e.message}`);
      }
    };

    pop.replaceChildren(
      el("div", { class: "cw-color-pop-title", text: `「${card.name}」的标记色` }),
      el(
        "div",
        { class: "cw-color-pop-row" },
        MARK_COLORS.map((color) =>
          el("button", {
            class: "cw-color-cell",
            title: color,
            dataset: { on: card.color === color ? "1" : "0" },
            style: `background:${color}`,
            onmousedown: (e) => {
              e.preventDefault();
              e.stopPropagation();
              pick(color);
            },
          })
        )
      ),
      el("button", {
        class: "cw-color-clear",
        text: "不要颜色",
        onmousedown: (e) => {
          e.preventDefault();
          e.stopPropagation();
          pick("");
        },
      })
    );

    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = 168;
    pop.style.left = `${Math.round(Math.min(window.innerWidth - w - 8, Math.max(8, r.left - 8)))}px`;
    pop.style.top = `${Math.round(r.bottom + 6)}px`;

    setTimeout(() => {
      this._colorOff = (ev) => {
        if (!pop.contains(ev.target)) this.hideColorPop();
      };
      window.addEventListener("pointerdown", this._colorOff, true);
    }, 0);
  }

  hideColorPop() {
    this.colorPop.hidden = true;
    if (this._colorOff) {
      window.removeEventListener("pointerdown", this._colorOff, true);
      this._colorOff = null;
    }
  }

  /* ---------- 提示词高亮层 ---------- */

  /**
   * textarea 里的字是透明的，看得见的是这层。
   * 只给「台上且有标记色」的 @名字 上色，其余保持普通文字色。
   */
  syncHighlight() {
    const hl = this.hl;
    const ta = this.ta;
    if (!hl || !ta) return;

    // 宽度对齐：textarea 出滚动条后可视宽度会变，高亮层必须跟着变，否则换行位置会错
    const scrollbar = Math.max(0, ta.offsetWidth - ta.clientWidth);
    hl.style.right = `${scrollbar}px`;
    hl.scrollTop = ta.scrollTop;

    const text = ta.value;
    const colored = new Map();
    for (const card of store.stagedCards) {
      if (card.color && card.name) colored.set(card.name, card.color);
    }

    if (!text) {
      hl.replaceChildren(document.createTextNode(" "));
      return;
    }

    if (!colored.size) {
      hl.textContent = text;
      if (text.endsWith("\n")) hl.append(document.createTextNode(" "));
      return;
    }

    const names = [...colored.keys()].sort((a, b) => b.length - a.length);
    const re = new RegExp("@(" + names.map(escapeRe).join("|") + ")", "g");

    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
      const name = m[1];
      frag.append(
        el(
          "span",
          { class: "cw-hl-mention", style: `color:${colored.get(name)}` },
          [document.createTextNode(`@${name}`)]
        )
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
    // 末尾换行在 pre-wrap 里会塌陷，补一个占位
    if (text.endsWith("\n")) frag.append(document.createTextNode(" "));

    hl.replaceChildren(frag);
  }

  syncScroll() {
    this.hl.scrollTop = this.ta.scrollTop;
  }

  /* ---------- 快捷按钮 ---------- */

  renderQuick() {
    const items = store.quickButtons || [];
    const gear = el("button", {
      class: "cw-quick-gear",
      text: "⚙",
      title: "设置快捷按钮（增删改）",
      onclick: (e) => {
        e.stopPropagation();
        this.openLibrary("quick");
      },
    });

    if (!items.length) {
      this.quickEl.replaceChildren(
        el("span", {
          class: "cw-quick-hint",
          text: "还没有快捷按钮，点 ⚙ 去加",
        }),
        gear
      );
      return;
    }
    this.quickEl.replaceChildren(
      ...items.map((item) =>
        el("button", {
          class: "cw-quick-item",
          text: item.label || "按钮",
          title: item.text || "",
          onclick: () => this.insertText(item.text || ""),
        })
      ),
      gear
    );
  }

  /* ---------- 文本插入 ---------- */

  insertText(text) {
    if (!text) return;
    const ta = this.ta;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);

    let chunk = text;
    // 前后自动补空格，免得拼成一坨
    if (before && !/[\s\n]$/.test(before) && !/^[,\s]/.test(chunk)) chunk = " " + chunk;
    if (after && !/^[\s\n,.，。]/.test(after) && !/[\s\n]$/.test(chunk)) chunk = chunk + " ";

    ta.value = before + chunk + after;
    const caret = before.length + chunk.length;
    ta.selectionStart = ta.selectionEnd = caret;
    this.prompt = ta.value;
    this.pushPayload();
    this.syncHighlight();
    ta.focus();
    this.hideSuggest();
  }

  /* ---------- @ 候选 ---------- */

  /** 光标前是否有一个正在输入的 @ 词（@ 前面不需要空格） */
  currentMention() {
    const ta = this.ta;
    const pos = ta.selectionStart ?? 0;
    if (pos !== ta.selectionEnd) return null;
    const upto = ta.value.slice(0, pos);
    // 允许紧贴中文/标点，只排除邮箱那种「字母数字@」的情况
    const m = /(^|[^A-Za-z0-9_@])@([^\s@]*)$/.exec(upto);
    if (!m) return null;
    return { start: pos - m[2].length - 1, query: m[2], pos };
  }

  updateSuggest() {
    const mention = this.currentMention();
    if (!mention) return this.hideSuggest();

    const q = mention.query.toLowerCase();
    const staged = store.stagedCards;

    if (!staged.length) {
      this.suggestions = [];
      this.suggestEl.replaceChildren(
        el("div", {
          class: "cw-suggest-empty",
          text: "台上没有卡，先去角色库选几张",
        })
      );
      this.suggestIndex = 0;
      this.showSuggest();
      return;
    }

    this.suggestions = staged.filter((c) =>
      (c.name || "").toLowerCase().includes(q)
    );

    if (!this.suggestions.length) {
      this.suggestEl.replaceChildren(
        el("div", { class: "cw-suggest-empty", text: `台上没有匹配「${mention.query}」的卡` })
      );
      this.suggestIndex = 0;
      this.showSuggest();
      return;
    }

    this.suggestIndex = 0;
    this.renderSuggestList();
    this.showSuggest();
  }

  renderSuggestList() {
    this.applyTheme();
    this.suggestEl.replaceChildren(
      ...this.suggestions.map((card, i) =>
        el(
          "div",
          {
            class: "cw-suggest-item",
            dataset: { active: i === this.suggestIndex ? "1" : "0" },
            onmousedown: (e) => {
              e.preventDefault();
              e.stopPropagation();
              this.applySuggestion(card);
            },
          },
          [
            card.thumb || card.main
              ? el("img", { src: assetUrl(card.thumb || card.main, store.bustOf(card.id)), alt: "" })
              : null,
            el("span", { class: "cw-suggest-name", text: card.name || "?" }),
            (card.identity || card.variable) && card.descOn !== false
              ? el("i", { class: "cw-suggest-desc", title: "带角色设定" })
              : null,
          ]
        )
      )
    );
  }

  showSuggest() {
    this.suggestEl.hidden = false;
    this.applyTheme();
    this.positionSuggest();
  }

  /** 贴着输入框弹，下面放不下就往上翻 */
  positionSuggest() {
    const r = this.ta.getBoundingClientRect();
    if (!r.width && !r.height) {
      this.suggestEl.hidden = true;
      return;
    }
    const box = this.suggestEl;
    box.style.minWidth = `${Math.min(300, Math.max(176, r.width * 0.62))}px`;

    const listHeight = Math.min(214, box.scrollHeight || 214);
    const below = window.innerHeight - r.bottom;
    const above = r.top;

    box.style.left = `${Math.round(r.left)}px`;
    if (below < listHeight + 18 && above > below) {
      box.style.top = `${Math.round(Math.max(6, r.top - listHeight - 6))}px`;
    } else {
      box.style.top = `${Math.round(r.bottom + 6)}px`;
    }
  }

  hideSuggest() {
    this.suggestEl.hidden = true;
    this.suggestions = [];
    this.suggestIndex = 0;
  }

  get suggestOpen() {
    return !this.suggestEl.hidden;
  }

  applySuggestion(card) {
    const mention = this.currentMention();
    if (!mention) return this.hideSuggest();

    const ta = this.ta;
    const insert = `@${card.name} `;
    ta.value = ta.value.slice(0, mention.start) + insert + ta.value.slice(mention.pos);
    const caret = mention.start + insert.length;
    ta.selectionStart = ta.selectionEnd = caret;
    this.prompt = ta.value;
    this.pushPayload();
    this.syncHighlight();
    this.hideSuggest();
    ta.focus();
  }

  onKeyDown(e) {
    if (e.ctrlKey && e.key === "Enter") return;   // 交给 ComfyUI 排队
    e.stopPropagation();

    if (!this.suggestOpen) {
      if (e.key === "Escape") this.ta.blur();
      return;
    }

    const n = this.suggestions.length;

    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      this.suggestIndex = (this.suggestIndex + 1) % n;
      this.renderSuggestList();
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      this.suggestIndex = (this.suggestIndex - 1 + n) % n;
      this.renderSuggestList();
    } else if ((e.key === "Enter" || e.key === "Tab") && n) {
      e.preventDefault();
      this.applySuggestion(this.suggestions[this.suggestIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.hideSuggest();
    }
  }

  /* ---------- 序列化 ---------- */

  pushPayload() {
    const widget = this.node.widgets?.find((w) => w.name === "payload");
    if (widget) widget.value = JSON.stringify({ prompt: this.prompt });
    app.graph?.setDirtyCanvas(true, true);
  }

  restoreFromPayload() {
    const widget = this.node.widgets?.find((w) => w.name === "payload");
    if (!widget || !widget.value) return;
    let prompt = "";
    try {
      const parsed = JSON.parse(widget.value);
      prompt = parsed && typeof parsed.prompt === "string" ? parsed.prompt : "";
    } catch (e) {
      prompt = typeof widget.value === "string" ? widget.value : "";
    }
    if (prompt) {
      this.prompt = prompt;
      this.ta.value = prompt;
      this.syncHighlight();
    }
  }

  /* ---------- 打开卡库 ---------- */

  async openLibrary(tab) {
    await openLibrary(tab);
  }
}

/* -------------------------------------------------------------------------
   注册
   ------------------------------------------------------------------------- */

function hideWidget(node, name) {
  const widget = node.widgets?.find((w) => w.name === name);
  if (!widget) return null;

  widget.type = "hidden";
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  widget.draw = () => {};
  widget.serializeValue = () => widget.value;

  // 万一某个版本还是给它建了 DOM，也一并压掉
  const killDom = (w) => {
    const domNode = w?.element || w?.inputEl;
    if (!domNode) return;
    domNode.style.setProperty("display", "none", "important");
    domNode.style.setProperty("height", "0", "important");
    domNode.style.setProperty("min-height", "0", "important");
    domNode.style.setProperty("padding", "0", "important");
    domNode.style.setProperty("margin", "0", "important");
    domNode.style.setProperty("border", "0", "important");
  };
  killDom(widget);
  // DOM 可能是延后一帧建的
  setTimeout(() => killDom(widget), 60);
  setTimeout(() => killDom(widget), 400);

  return widget;
}

app.registerExtension({
  name: "comfy.characterworkbench",

  async setup() {
    injectStyle();
    store.load().catch((e) => console.warn("[怪兽牌组] 预加载卡片库失败", e));
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    // 旧版本被撑坏的节点（高度几千），加载工作流时拉回正常尺寸
    const normalizeSize = (node) => {
      const w = Math.max(node.size?.[0] || 0, 340);
      let h = node.size?.[1] || DEFAULT_SIZE[1];
      if (!Number.isFinite(h) || h < 320) h = DEFAULT_SIZE[1];
      if (h > MAX_NODE_HEIGHT) h = DEFAULT_SIZE[1];
      node.setSize([w, h]);
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const node = this;

      hideWidget(node, "payload");

      const container = document.createElement("div");
      node.addDOMWidget("cw_ui", "cw_workbench", container, {
        serialize: false,
        hideOnZoom: false,
        // 常量，不读 node.size —— 见 MIN_CONTENT_HEIGHT 上方注释
        getMinHeight: () => MIN_CONTENT_HEIGHT,
        getMaxHeight: () => 4000,
      });

      const ui = new WorkbenchUI(node, container);
      node.__cw = ui;

      node.setSize([
        Math.max(node.size?.[0] || 0, DEFAULT_SIZE[0]),
        Math.max(node.size?.[1] || 0, DEFAULT_SIZE[1]),
      ]);

      ui.ensureLibrary();
      return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = onConfigure?.apply(this, arguments);
      const node = this;
      // widget 值在 configure 之后才恢复，所以延后一帧再读
      requestAnimationFrame(() => {
        normalizeSize(node);
        node.__cw?.restoreFromPayload();
      });
      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this.__cw?.dispose?.();
      this.__cw = null;
      return onRemoved?.apply(this, arguments);
    };
  },

  getCustomWidgets() {
    return {};
  },
});
