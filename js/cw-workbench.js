/**
 * 怪兽牌组 —— 节点内创作台
 *
 * 这里是唯一有 @ 交互的地方，而 @ 只认「台上的卡」。
 * 台上没卡就什么都 @ 不到 —— 这正是要的效果。
 */

import { app } from "../../scripts/app.js";
import { store, el, injectStyle, assetUrl, isDarkTheme, toast, cwApi } from "./cw-core.js";
import { openLibrary } from "./cw-library.js";

const NODE_CLASS = "CharacterWorkbench";
const DEFAULT_SIZE = [470, 664];

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
 *
 * （后来又加了「快速参考图」区，最小高度从 300 提到 440 —— 同样是常量，
 *   逻辑没变，只是内容底噪变高了。）
 */
const MIN_CONTENT_HEIGHT = 440;

/** 超过这个高度就认为是坏数据，加载时拉回默认尺寸 */
const MAX_NODE_HEIGHT = 1600;

/** 工作台卡的标记色（和节点主题色系接近，深色浅色下都看得清） */
const MARK_COLORS = [
  "#d9534f", "#e08b3c", "#c9a227", "#5aa469",
  "#3f8ad4", "#7a6ad4", "#c060a1", "#e2e2e2",
];

/** 快速参考图在提示词里的高亮色：和卡的「可自定义标记色」区分开 */
const QREF_COLOR = "#c0873c";

/** 最多几张：再多就要两行往上，提示词框会被挤没 */
const QREF_MAX = 6;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* -------------------------------------------------------------------------
   节点内 UI
   ------------------------------------------------------------------------- */

class WorkbenchUI {
  constructor(node, container) {
    this.node = node;
    this.container = container;
    this.prompt = "";
    // 快速参考图：从外面拖/粘进来的临时素材。不进卡库，用完即扔。
    // 结构 { file: "_quick/xxx.png", name: "参考1" }
    this.quickRefs = [];
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
      this.qrefInput?.remove();
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

    // ---- 快速参考图 ----
    // 定位：和「台上角色」并列的另一类素材。角色卡是长期资产，
    // 这里是「刚从外面拿回来的东西」—— 拖进来、@ 一下、出完图就可以扔。
    this.qrefGrid = el("div", { class: "cw-qref-grid" });
    this.qrefClearBtn = el("button", {
      class: "cw-qref-clear",
      type: "button",
      text: "清空",
      title: "把所有快速参考图拿走（图也删掉）",
      onclick: (e) => {
        e.stopPropagation();
        this.clearQuickRefs();
      },
    });
    this.qrefEl = el("div", { class: "cw-qref" }, [
      el("div", { class: "cw-qref-head" }, [
        el("span", { class: "cw-qref-title", text: "快速参考图" }),
        el("span", { class: "cw-qref-hint", text: "拖进来 / Ctrl+V" }),
        this.qrefClearBtn,
      ]),
      this.qrefGrid,
    ]);

    // 引用标记：决定 @卡名 最后换成什么。
    // Qwen 编辑认 "image 1"，MiniMax H3 视频只认 "<Picture 1>"。
    // 全局设置只能选一种，来回切太容易忘，所以每个节点自己带一个。
    this.tagSel = el(
      "select",
      {
        class: "cw-tag-select",
        title:
          "@卡名 替换成哪种标记。视频（MiniMax H3）用 <Picture 1>；图像编辑（Qwen）用 image 1。",
      },
      [
        el("option", { value: "", text: "跟随设置" }),
        el("option", { value: "image {n}", text: "image 1" }),
        el("option", { value: "<Picture {n}>", text: "<Picture 1>" }),
        el("option", { value: "图{n}", text: "图1" }),
        el("option", { value: "图 {n}", text: "图 1" }),
      ]
    );
    this.tagSel.value = "";
    this.tagSel.addEventListener("change", () => this.pushPayload());

    this.headEl = el("div", { class: "cw-node-head" }, [
      el("div", { class: "cw-node-head-left" }, [this.countEl, this.tagSel]),
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
      this.qrefEl,
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

    this.bindQuickDrop();
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
    this.renderQuickRefs();
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

  /* ---------- 快速参考图 ---------- */

  /**
   * 「从外面拿回来的东西」的入口。
   *
   * 三个动作都指向同一个池子：拖进来、Ctrl+V、点空槽选文件。
   * 图上传到 _quick/，payload 里只记相对路径 —— 工作流 JSON 不会被 base64 撑爆。
   */
  bindQuickDrop() {
    const zone = this.qrefEl;

    const hasFiles = (e) => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      const types = Array.from(dt.types || []);
      return types.includes("Files") || types.some((t) => String(t).startsWith("image/"));
    };

    const clearOver = () => zone.classList.remove("is-over");

    // 整块节点都能接：用户不用瞄准那三个小格子
    this.container.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      zone.classList.add("is-over");
    });
    this.container.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && this.container.contains(e.relatedTarget)) return;
      clearOver();
    });
    this.container.addEventListener("drop", async (e) => {
      if (!hasFiles(e)) return;
      // 不拦住的话 ComfyUI 画布会把这张图变成一个新的 LoadImage 节点
      e.preventDefault();
      e.stopPropagation();
      clearOver();
      await this.addQuickFiles(e.dataTransfer?.files);
    });

    // 粘贴：焦点在提示词框里也能粘图 —— 图进参考图槽，不干扰文本输入
    this.container.addEventListener("paste", async (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const blobs = items
        .filter((it) => it.kind === "file" && String(it.type || "").startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (!blobs.length) return;
      e.preventDefault();
      e.stopPropagation();
      await this.addQuickFiles(blobs);
    });
  }

  renderQuickRefs() {
    const refs = this.quickRefs;
    const cells = [];

    refs.forEach((ref, i) => {
      const cell = el("div", {
        class: "cw-qref-cell is-filled" + (ref.pending ? " is-pending" : ""),
        title: ref.pending
          ? "正在放进来…"
          : `点一下把 @${ref.name} 插进提示词（右上角 × 拿走）`,
        onclick: () => {
          if (!ref.pending) this.insertText(`@${ref.name} `);
        },
      });

      if (ref.pending) {
        cell.append(el("span", { class: "cw-qref-spin", text: "…" }));
        cells.push(cell);
      } else {
        cell.append(
          el("img", {
            src: assetUrl(ref.file, 0),
            alt: "",
            draggable: "false",
            onerror: () => cell.classList.add("is-broken"),
          })
        );
        cell.append(el("span", { class: "cw-qref-name", text: `@${ref.name}` }));
        cell.append(
          el("button", {
            class: "cw-qref-x",
            type: "button",
            text: "×",
            title: "拿走（图也一起删）",
            onclick: (e) => {
              e.stopPropagation();
              this.removeQuickRef(i);
            },
          })
        );
        cells.push(cell);
      }
    });

    // 至少三个位置；填满三个后仍留一个空位继续加，到上限就收口
    const empties =
      refs.length >= QREF_MAX ? 0 : Math.max(1, 3 - refs.length);
    for (let k = 0; k < empties; k++) {
      const slot = el(
        "button",
        {
          class: "cw-qref-cell is-empty",
          type: "button",
          title: "点这里选图；也可以直接把图拖到节点上，或复制图片后 Ctrl+V",
          onclick: () => this.pickQuickFile(),
        },
        [el("span", { class: "cw-qref-plus", text: "+" })]
      );
      if (k === 0) slot.append(el("span", { class: "cw-qref-tip", text: "拖 / 粘贴" }));
      cells.push(slot);
    }

    this.qrefGrid.replaceChildren(...cells);
    this.qrefClearBtn.hidden = !refs.length;
  }

  pickQuickFile() {
    if (!this.qrefInput) {
      const input = el("input", { type: "file", accept: "image/*" });
      input.multiple = true;
      input.style.display = "none";
      input.addEventListener("change", async () => {
        const files = Array.from(input.files || []);
        input.value = "";
        await this.addQuickFiles(files);
      });
      document.body.append(input);
      this.qrefInput = input;
    }
    this.qrefInput.click();
  }

  async addQuickFiles(files) {
    const all = Array.from(files || []);
    if (!all.length) return;
    const imgs = all.filter((f) => f && String(f.type || "").startsWith("image/"));
    if (!imgs.length) return toast("只收图片");

    // 上限 6 张：再多就两行起步，会把提示词框挤没
    const room = QREF_MAX - this.quickRefs.length;
    if (room <= 0) return toast(`快速参考图最多 ${QREF_MAX} 张，先拿走几张`);
    const list = imgs.slice(0, room);
    if (imgs.length > room) toast(`只能再放 ${room} 张，多的没进来`);

    for (const file of list) await this.addQuickFile(file);
  }

  async addQuickFile(file) {
    // 先占位再上传：上传有往返，不给反馈用户会以为没吃进去
    const ref = { file: "", name: this.nextRefName(), pending: true };
    this.quickRefs.push(ref);
    this.renderQuickRefs();

    try {
      const res = await cwApi.upload(file, { slot: "quick" });
      if (!res || !res.file) throw new Error("没拿到文件路径");
      ref.file = res.file;
      ref.pending = false;
    } catch (e) {
      this.quickRefs = this.quickRefs.filter((r) => r !== ref);
      toast(`放不进去：${e.message}`);
    }

    this.renderQuickRefs();
    this.pushPayload();
  }

  /** 名字是 @ 的唯一钥匙：编号从小往大找空位，且必须避开台上的卡名 */
  nextRefName() {
    const used = new Set(this.quickRefs.map((r) => r.name));
    for (const card of store.stagedCards) {
      if (card.name) used.add(card.name);
    }
    for (let i = 1; i <= 99; i++) {
      const name = `参考${i}`;
      if (!used.has(name)) return name;
    }
    return `参考${this.quickRefs.length + 1}`;
  }

  async removeQuickRef(i) {
    const ref = this.quickRefs[i];
    if (!ref) return;
    this.quickRefs.splice(i, 1);
    this.renderQuickRefs();
    this.pushPayload();
    if (!ref.file) return;
    try {
      await cwApi.quickRefDelete(ref.file);
    } catch (e) {
      // 删不掉只是留个垃圾文件，prune 会收，不必打扰用户
    }
  }

  async clearQuickRefs() {
    if (!this.quickRefs.length) return;
    const all = this.quickRefs.slice();
    this.quickRefs = [];
    this.renderQuickRefs();
    this.pushPayload();
    for (const ref of all) {
      if (!ref.file) continue;
      try {
        await cwApi.quickRefDelete(ref.file);
      } catch (e) {
        /* 同上 */
      }
    }
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
    // 临时参考图没有标记色，统一给一个琥珀色，跟卡区分开
    for (const ref of this.quickRefs) {
      if (ref.file && ref.name) colored.set(ref.name, QREF_COLOR);
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
    // 台上卡和临时参考图都能 @ —— 对提示词来说它们是一样的东西
    const pool = [
      ...store.stagedCards,
      ...this.quickRefs
        .filter((r) => r.file && r.name)
        .map((r) => ({ name: r.name, thumb: r.file, qref: true })),
    ];

    if (!pool.length) {
      this.suggestions = [];
      this.suggestEl.replaceChildren(
        el("div", {
          class: "cw-suggest-empty",
          text: "台上没卡、也没有临时参考图 —— 先去拿点东西回来",
        })
      );
      this.suggestIndex = 0;
      this.showSuggest();
      return;
    }

    this.suggestions = pool.filter((c) =>
      (c.name || "").toLowerCase().includes(q)
    );

    if (!this.suggestions.length) {
      this.suggestEl.replaceChildren(
        el("div", { class: "cw-suggest-empty", text: `台上没有匹配「${mention.query}」的东西` })
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
              ? el("img", {
                  src: assetUrl(card.thumb || card.main, card.id ? store.bustOf(card.id) : 0),
                  alt: "",
                })
              : null,
            el("span", { class: "cw-suggest-name", text: card.name || "?" }),
            card.qref
              ? el("i", { class: "cw-suggest-qref", title: "临时参考图" })
              : (card.identity || card.variable) && card.descOn !== false
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
    if (widget) {
      const payload = { prompt: this.prompt };
      // 只存路径，不存图本身 —— 否则工作流 JSON 会被 base64 撑到几十兆
      const quick = this.quickRefs
        .filter((r) => r.file)
        .map((r) => ({ file: r.file, name: r.name }));
      if (quick.length) payload.quick = quick;
      if (this.tagSel?.value) payload.tag = this.tagSel.value;
      widget.value = JSON.stringify(payload);
    }
    app.graph?.setDirtyCanvas(true, true);
  }

  restoreFromPayload() {
    const widget = this.node.widgets?.find((w) => w.name === "payload");
    if (!widget || !widget.value) return;
    let prompt = "";
    let quick = [];
    let tag = "";
    try {
      const parsed = JSON.parse(widget.value);
      prompt = parsed && typeof parsed.prompt === "string" ? parsed.prompt : "";
      if (parsed && Array.isArray(parsed.quick)) quick = parsed.quick;
      if (parsed && typeof parsed.tag === "string") tag = parsed.tag;
    } catch (e) {
      prompt = typeof widget.value === "string" ? widget.value : "";
    }
    if (this.tagSel) {
      this.tagSel.value = tag;
      // 存的值不在选项里（老工作流 / 手改过 JSON）就退回「跟随设置」
      if (this.tagSel.value !== tag) this.tagSel.value = "";
    }
    if (prompt) {
      this.prompt = prompt;
      this.ta.value = prompt;
      this.syncHighlight();
    }

    // 上次没扔掉的临时图跟着工作流一起回来（文件还在就还在）
    this.quickRefs = quick
      .filter((r) => r && typeof r.file === "string" && r.file)
      .map((r, i) => ({
        file: r.file,
        name: (r.name || "").trim() || `参考${i + 1}`,
        pending: false,
      }));
    this.renderQuickRefs();
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
      const w = Math.max(node.size?.[0] || 0, 400);
      let h = node.size?.[1] || DEFAULT_SIZE[1];
      // 加了快速参考图区之后，太矮的节点会把提示词框挤没
      const minH = 560;
      if (!Number.isFinite(h) || h < minH) h = DEFAULT_SIZE[1];
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
