/**
 * 怪兽牌组 —— 全屏卡库
 *
 * 只有一个入口：openLibrary()
 * 只管「卡从哪来、有哪些卡、哪些上台」，提示词不归它管。
 */

import { cwApi, store, el, isDarkTheme, toast, injectStyle, assetUrl } from "./cw-core.js";
import { openSupplement } from "./cw-supplement.js";
import { openNewCard } from "./cw-newcard.js";
import { openPresetEditor, isEditingPreset } from "./cw-wfedit.js";
import { openCrop } from "./cw-crop.js";

const PALETTE = [
  "#d9534f", "#e08b3c", "#c9a227", "#5aa469",
  "#3f8ad4", "#7a6ad4", "#c060a1", "#6b7280",
];

/* -------------------------------------------------------------------------
   小对话框（Electron 里 window.prompt 不可用，自己画）
   ------------------------------------------------------------------------- */

function dialogShell(title, bodyNode, actions) {
  const mask = el("div", { class: "cw-dialog-mask" });
  const box = el("div", { class: "cw-dialog" }, [
    el("div", { class: "cw-dialog-title", text: title }),
    el("div", { class: "cw-dialog-body" }, [bodyNode]),
    el("div", { class: "cw-dialog-acts" }, actions),
  ]);
  mask.append(box);
  mask.addEventListener("mousedown", (e) => {
    if (e.target === mask) mask.dispatchEvent(new CustomEvent("cw-cancel"));
  });
  return mask;
}

function askText({ title, label, value = "", placeholder = "", confirm = "确定" }) {
  return new Promise((resolve) => {
    const input = el("input", { class: "cw-input", value, placeholder });
    const body = el("div", { class: "cw-field" }, [
      label ? el("label", { text: label }) : null,
      input,
    ]);

    const finish = (v) => {
      mask.remove();
      resolve(v);
    };
    const okBtn = el("button", {
      class: "cw-btn-lg cw-primary",
      text: confirm,
      onclick: () => finish(input.value.trim() || null),
    });
    const cancelBtn = el("button", {
      class: "cw-btn-lg",
      text: "取消",
      onclick: () => finish(null),
    });

    const mask = dialogShell(title, body, [cancelBtn, okBtn]);
    mask.addEventListener("cw-cancel", () => finish(null));

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        okBtn.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    });

    mountDialog(mask);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

function askConfirm({ title, message, confirm = "删除", danger = true }) {
  return new Promise((resolve) => {
    const body = el("div", { class: "cw-hint", text: message });
    const finish = (v) => {
      mask.remove();
      resolve(v);
    };
    const okBtn = el("button", {
      class: `cw-btn-lg cw-primary${danger ? " cw-danger" : ""}`,
      text: confirm,
      onclick: () => finish(true),
    });
    const cancelBtn = el("button", {
      class: "cw-btn-lg",
      text: "取消",
      onclick: () => finish(false),
    });
    const mask = dialogShell(title, body, [cancelBtn, okBtn]);
    mask.addEventListener("cw-cancel", () => finish(false));
    mask.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") finish(false);
    });
    mountDialog(mask);
    requestAnimationFrame(() => cancelBtn.focus());
  });
}

function askCategory(cat) {
  return new Promise((resolve) => {
    let picked = cat?.color || PALETTE[0];
    const nameInput = el("input", {
      class: "cw-input",
      value: cat?.name || "",
      placeholder: "分类名字",
    });

    const swatches = el(
      "div",
      { class: "cw-swatches" },
      PALETTE.map((color) =>
        el("button", {
          class: "cw-swatch",
          title: color,
          style: `background:${color}`,
          dataset: { color, on: color === picked ? "1" : "0" },
          onclick: (e) => {
            picked = color;
            swatches
              .querySelectorAll(".cw-swatch")
              .forEach((s) => (s.dataset.on = s.dataset.color === color ? "1" : "0"));
          },
        })
      )
    );

    const body = el("div", { class: "cw-field" }, [
      el("label", { text: "名字" }),
      nameInput,
      el("label", { text: "颜色", style: "margin-top:6px" }),
      swatches,
    ]);

    const finish = (v) => {
      mask.remove();
      resolve(v);
    };

    const actions = [];
    if (cat) {
      actions.push(
        el("button", {
          class: "cw-btn-lg cw-danger",
          text: "删除分类",
          onclick: () => finish({ remove: true }),
        })
      );
    }
    actions.push(
      el("button", { class: "cw-btn-lg", text: "取消", onclick: () => finish(null) }),
      el("button", {
        class: "cw-btn-lg cw-primary",
        text: "保存",
        onclick: () => {
          const name = nameInput.value.trim();
          if (!name) return nameInput.focus();
          finish({ name, color: picked });
        },
      })
    );

    const mask = dialogShell(cat ? "编辑分类" : "新建分类", body, actions);
    mask.addEventListener("cw-cancel", () => finish(null));
    nameInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        actions[actions.length - 1].click();
      } else if (e.key === "Escape") {
        finish(null);
      }
    });

    mountDialog(mask);
    requestAnimationFrame(() => {
      nameInput.focus();
      nameInput.select();
    });
  });
}

function pickFile(accept = "image/*") {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept, style: "display:none" });
    input.addEventListener("change", () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      input.remove();
      resolve(file);
    });
    document.body.append(input);
    input.click();
  });
}

/** 对话框要挂在浮层内部才拿得到主题变量 */
function mountDialog(mask) {
  const shell = document.querySelector(".cw-shell");
  (shell || document.body).append(mask);
}

/* -------------------------------------------------------------------------
   卡库面板
   ------------------------------------------------------------------------- */

class LibraryPanel {
  constructor() {
    this.tab = "all";
    this.search = "";
    this.editingId = null;
    this.ready = null;
    this.build();
  }

  /* ---------- 骨架 ---------- */

  build() {
    this.tabsEl = el("div", { class: "cw-tabs" });

    this.searchInput = el("input", {
      class: "cw-search",
      placeholder: "搜索卡片…",
      oninput: (e) => {
        this.search = e.target.value.trim().toLowerCase();
        this.renderGrid();
      },
    });

    this.headEl = el("header", { class: "cw-head" }, [
      el("div", { class: "cw-brand" }, [
        el("b", { text: "角色库" }),
        el("span", { text: "选卡上台，提示词里用 @ 引用" }),
      ]),
      this.tabsEl,
      el("div", { class: "cw-head-tools" }, [
        this.searchInput,
        el("button", {
          class: "cw-btn-lg cw-primary",
          text: "＋ 新建卡",
          onclick: () => this.createCard(),
        }),
        el("button", {
          class: "cw-iconbtn",
          text: "✕",
          title: "关闭 (Esc)",
          onclick: () => this.close(),
        }),
      ]),
    ]);

    this.bodyEl = el("div", { class: "cw-body" });
    this.footEl = el("footer", { class: "cw-foot" });

    this.modal = el("div", { class: "cw-modal" }, [this.headEl, this.bodyEl, this.footEl]);
    this.root = el("div", { class: "cw-shell" }, [this.modal]);
    this.root.style.display = "none";

    this.onKey = (e) => {
      if (e.key === "Escape" && !document.querySelector(".cw-dialog-mask")) {
        this.close();
      }
    };

    document.body.append(this.root);
  }

  /* ---------- 打开 / 关闭 ---------- */

  async open(tab) {
    injectStyle();
    if (tab && tab !== this.tab) {
      this.tab = tab;
      this.closeEditor();
    }
    this.root.classList.toggle("cw-dark", isDarkTheme());
    this.root.style.display = "flex";
    document.addEventListener("keydown", this.onKey, true);

    this.unsub = store.subscribe(() => this.renderTabs());

    if (!store.lib) {
      this.bodyEl.replaceChildren(el("div", { class: "cw-empty", text: "正在读取卡片库…" }));
      try {
        await store.load(true);
      } catch (e) {
        this.bodyEl.replaceChildren(
          el("div", { class: "cw-empty" }, [
            el("b", { text: "连不上插件后端" }),
            String(e.message || e),
          ])
        );
        return;
      }
    }
    this.render();
  }

  close() {
    this.root.style.display = "none";
    this.closeEditor();
    document.removeEventListener("keydown", this.onKey, true);
    this.unsub?.();
  }

  get isOpen() {
    return this.root.style.display !== "none";
  }

  /* ---------- 渲染 ---------- */

  render() {
    this.renderTabs();
    this.renderBody();
    this.renderFoot();
  }

  renderTabs() {
    const counts = new Map();
    for (const c of store.cards) {
      counts.set(c.categoryId || "__none", (counts.get(c.categoryId || "__none") || 0) + 1);
    }
    const hasUnfiled = (counts.get("__none") || 0) > 0;

    const items = [
      el("button", {
        class: "cw-tab",
        dataset: { on: this.tab === "all" ? "1" : "0" },
        text: "全部",
        onclick: () => this.switchTab("all"),
      }),
    ];

    for (const cat of store.categories) {
      items.push(
        el(
          "button",
          {
            class: "cw-tab",
            dataset: { on: this.tab === cat.id ? "1" : "0" },
            title: "双击可改名 / 改色 / 删除",
            onclick: () => this.switchTab(cat.id),
            ondblclick: (e) => {
              e.preventDefault();
              this.editCategory(cat);
            },
          },
          [
            el("span", { class: "cw-tab-dot", style: `background:${cat.color || "#888"}` }),
            el("span", { text: cat.name }),
            el("span", { class: "cw-tab-n", text: String(counts.get(cat.id) || 0) }),
          ]
        )
      );
    }

    if (hasUnfiled) {
      items.push(
        el(
          "button",
          {
            class: "cw-tab",
            dataset: { on: this.tab === "__none" ? "1" : "0" },
            onclick: () => this.switchTab("__none"),
          },
          [
            el("span", { text: "未分类" }),
            el("span", { class: "cw-tab-n", text: String(counts.get("__none") || 0) }),
          ]
        )
      );
    }

    items.push(
      el("button", {
        class: "cw-tab",
        title: "新建分类",
        text: "＋",
        onclick: () => this.addCategory(),
      })
    );

    items.push(
      el("button", {
        class: "cw-tab",
        dataset: { on: this.tab === "quick" ? "1" : "0" },
        text: "⚡ 快捷按钮",
        onclick: () => this.switchTab("quick"),
      }),
      el("button", {
        class: "cw-tab",
        dataset: { on: this.tab === "settings" ? "1" : "0" },
        text: "⚙ 设置",
        onclick: () => this.switchTab("settings"),
      })
    );

    this.tabsEl.replaceChildren(...items);
  }

  renderBody() {
    if (this.tab === "quick") return this.renderQuick();
    if (this.tab === "settings") return this.renderSettings();
    return this.renderGrid();
  }

  renderGrid() {
    let cards = store.cards;
    if (this.tab === "__none") cards = cards.filter((c) => !c.categoryId);
    else if (this.tab !== "all") cards = cards.filter((c) => c.categoryId === this.tab);

    if (this.search) {
      cards = cards.filter((c) => {
        const hay = `${c.name || ""} ${c.note || ""} ${c.identity || ""} ${c.variable || ""} ${c.detail || ""} ${(c.tags || []).join(" ")}`.toLowerCase();
        return hay.includes(this.search);
      });
    }

    if (!cards.length) {
      this.bodyEl.replaceChildren(
        el("div", { class: "cw-empty" }, [
          el("b", { text: this.search ? "没搜到" : "这个分类还是空的" }),
          this.search ? "换个关键词试试" : "点右上角「新建卡」把第一张放进来",
        ])
      );
      return;
    }

    const grid = el("div", { class: "cw-grid" }, cards.map((c) => this.cardNode(c)));
    this.bodyEl.replaceChildren(grid);
  }

  cardNode(card) {
    const staged = store.isStaged(card.id);
    const hasDesc = !!(card.identity || card.variable || card.detail);
    const node = el("div", {
      class: "cw-card",
      dataset: { on: staged ? "1" : "0", id: card.id },
      title: "点击上台 / 下台 · 双击编辑",
      onclick: () => this.toggleStage(card.id),
      ondblclick: (e) => {
        e.preventDefault();
        this.openEditor(card.id);
      },
    });

    const imgWrap = el("div", { class: "cw-card-img" });
    if (card.thumb || card.main) {
      const img = el("img", {
        src: assetUrl(card.thumb || card.main, store.bustOf(card.id)),
        alt: card.name || "",
        loading: "lazy",
      });
      img.addEventListener("error", () => {
        img.remove();
        imgWrap.append(el("div", { class: "cw-card-noimg", text: "图丢了" }));
      });
      imgWrap.append(img);
    } else {
      imgWrap.append(el("div", { class: "cw-card-noimg", text: "还没图" }));
    }

    const cat = store.categories.find((c) => c.id === card.categoryId);
    if (cat) {
      imgWrap.append(
        el("div", {
          class: "cw-card-badge",
          text: cat.name,
          style: `background:${cat.color || "#333"}cc`,
        })
      );
    }

    imgWrap.append(el("div", { class: "cw-card-on", text: "✓" }));
    if (card.color) {
      imgWrap.append(
        el("div", { class: "cw-card-color", title: "工作台标记色", style: `background:${card.color}` })
      );
    }
    imgWrap.append(
      el("div", { class: "cw-card-acts" }, [
        el("button", {
          text: "✎",
          title: "编辑",
          onclick: (e) => {
            e.stopPropagation();
            this.openEditor(card.id);
          },
        }),
        el("button", {
          text: "🗑",
          title: "删除",
          onclick: (e) => {
            e.stopPropagation();
            this.removeCard(card);
          },
        }),
      ])
    );

    node.append(imgWrap);
    node.append(
      el("div", { class: "cw-card-meta" }, [
        el("div", { class: "cw-card-name" }, [
          el("span", { text: card.name || "未命名" }),
          hasDesc
            ? el("i", {
                class: "cw-card-desc",
                title: card.descOn === false ? "有设定，但这张卡关掉了发送" : "带角色设定，@ 时会一起送给模型",
                dataset: { off: card.descOn === false ? "1" : "0" },
              })
            : null,
        ]),
        el("div", {
          class: "cw-card-sub",
          text: (card.extras || []).length
            ? `主图 + ${(card.extras || []).length} 张补充`
            : cat?.name || "未分类",
        }),
      ])
    );

    return node;
  }

  /** 只更新台上的视觉状态，避免整块重绘闪烁 */
  refreshStaged() {
    for (const node of this.bodyEl.querySelectorAll(".cw-card")) {
      node.dataset.on = store.isStaged(node.dataset.id) ? "1" : "0";
    }
    this.renderFoot();
  }

  renderFoot() {
    const staged = store.stagedCards;
    const chips = staged.map((c) =>
      el("div", { class: "cw-mini" }, [
        c.thumb || c.main
          ? el("img", { src: assetUrl(c.thumb || c.main, store.bustOf(c.id)), alt: "" })
          : null,
        el("span", { text: c.name || "未命名" }),
        el("button", {
          text: "×",
          title: "下台",
          onclick: (e) => {
            e.stopPropagation();
            this.toggleStage(c.id);
          },
        }),
      ])
    );

    this.footEl.replaceChildren(
      el("div", { class: "cw-foot-stage" }, [
        el("span", {
          text: staged.length ? `台上 ${staged.length} 张` : "台上还没有卡",
          style: "flex:0 0 auto;opacity:.75",
        }),
        ...chips,
      ]),
      el("button", {
        class: "cw-btn-lg cw-primary",
        text: "完成",
        onclick: () => this.close(),
      })
    );
  }

  /* ---------- 交互 ---------- */

  switchTab(tab) {
    this.tab = tab;
    this.closeEditor();
    this.render();
  }

  async toggleStage(id) {
    try {
      await store.toggleStage(id);
      this.refreshStaged();
      this.renderTabs();
    } catch (e) {
      toast(`操作失败：${e.message}`);
    }
  }

  async createCard() {
    const categoryId =
      this.tab !== "all" && this.tab !== "quick" && this.tab !== "settings" && this.tab !== "__none"
        ? this.tab
        : store.categories[0]?.id || "";

    let card = null;
    try {
      card = await openNewCard({
        categories: store.categories,
        defaultCategoryId: categoryId,
      });
    } catch (e) {
      toast(`创建失败：${e.message}`);
      return;
    }
    if (!card) return;

    try {
      await store.refresh();
      this.render();
      // 底稿已经有了，直接进抽屉让人接着写设定 / 补图
      this.openEditor(card.id, { fresh: false });
    } catch (e) {
      toast(e.message);
    }
  }

  async removeCard(card) {
    const ok = await askConfirm({
      title: "删除这张卡？",
      message: `「${card.name}」的图片文件会一起删掉，不可恢复。`,
      confirm: "删除",
    });
    if (!ok) return;
    try {
      await cwApi.deleteCard(card.id);
      await store.refresh();
      if (this.editingId === card.id) this.closeEditor();
      this.render();
      toast("已删除");
    } catch (e) {
      toast(`删除失败：${e.message}`);
    }
  }

  async addCategory() {
    const result = await askCategory(null);
    if (!result || result.remove) return;
    try {
      await cwApi.addCategory(result);
      await store.refresh();
      this.render();
    } catch (e) {
      toast(`新建分类失败：${e.message}`);
    }
  }

  async editCategory(cat) {
    const result = await askCategory(cat);
    if (!result) return;
    try {
      if (result.remove) {
        const ok = await askConfirm({
          title: `删除分类「${cat.name}」？`,
          message: "分类里的卡不会删，会变成「未分类」。",
          confirm: "删除分类",
        });
        if (!ok) return;
        await cwApi.deleteCategory(cat.id);
        if (this.tab === cat.id) this.tab = "all";
      } else {
        await cwApi.updateCategory(cat.id, result);
      }
      await store.refresh();
      this.render();
    } catch (e) {
      toast(`操作失败：${e.message}`);
    }
  }

  /* ---------- 快捷按钮 ---------- */

  renderQuick() {
    const rows = store.quickButtons.map((item) =>
      el("div", { class: "cw-row" }, [
        this.quickField(item, "label", "按钮名"),
        this.quickField(item, "text", "点一下插入的提示词"),
        el("button", {
          class: "cw-iconbtn cw-danger",
          text: "🗑",
          title: "删除",
          onclick: async () => {
            try {
              await cwApi.deleteQuick(item.id);
              await store.refresh();
              this.renderQuick();
            } catch (e) {
              toast(e.message);
            }
          },
        }),
      ])
    );

    this.bodyEl.replaceChildren(
      el("div", { class: "cw-section-title", text: "快捷按钮" }),
      el("div", { class: "cw-hint", style: "margin-bottom:14px" }, [
        "节点底部那一排就是它们。点一下把文字插到光标处，可以反复点、连着拼。",
      ]),
      el("div", { class: "cw-rows" }, [
        ...rows,
        el("button", {
          class: "cw-btn-lg",
          text: "＋ 添加按钮",
          style: "align-self:flex-start;margin-top:4px",
          onclick: async () => {
            try {
              await cwApi.addQuick({ label: "新按钮", text: "" });
              await store.refresh();
              this.renderQuick();
            } catch (e) {
              toast(e.message);
            }
          },
        }),
      ])
    );
  }

  quickField(item, field, placeholder) {
    let timer = null;
    const input = el("input", {
      class: "cw-input",
      value: item[field] || "",
      placeholder,
    });
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await cwApi.updateQuick(item.id, { [field]: input.value });
          const target = store.quickButtons.find((q) => q.id === item.id);
          if (target) target[field] = input.value;
          store.emit("quick");
        } catch (e) {
          toast(e.message);
        }
      }, 500);
    });
    return input;
  }

  /* ---------- 设置 ---------- */

  renderSettings() {
    const s = store.settings;

    const templateInput = el("input", {
      class: "cw-input",
      value: s.refTemplate || "image {n}",
      style: "max-width:280px",
    });
    const mpInput = el("input", {
      class: "cw-input",
      type: "number",
      step: "0.1",
      min: "0.1",
      value: s.maxMegapixel ?? 1,
      style: "max-width:140px",
    });
    const extrasBox = el("input", { type: "checkbox" });
    extrasBox.checked = !!s.sendExtras;

    const descSelect = el(
      "select",
      { class: "cw-select", style: "max-width:340px" },
      [
        el("option", { value: "off", text: "不发送 —— 只送参考图" }),
        el("option", { value: "core", text: "身份锚定 + 可变项（推荐）" }),
        el("option", { value: "full", text: "全部，含详细设定（可能干扰参考图）" }),
      ]
    );
    descSelect.value = s.descMode || "core";

    const descTplInput = el("input", {
      class: "cw-input",
      value: s.descTemplate || "{ref} 是{name}。外观：{identity}。{variable}。",
    });

    const save = async () => {
      try {
        await cwApi.saveSettings({
          refTemplate: templateInput.value || "image {n}",
          maxMegapixel: parseFloat(mpInput.value) || 1,
          sendExtras: extrasBox.checked,
          descMode: descSelect.value,
          descTemplate: descTplInput.value || "{ref} 是{name}。外观：{identity}。{variable}。",
        });
        await store.refresh();
        toast("已保存");
      } catch (e) {
        toast(`保存失败：${e.message}`);
      }
    };

    templateInput.addEventListener("change", save);
    mpInput.addEventListener("change", save);
    extrasBox.addEventListener("change", save);
    descSelect.addEventListener("change", save);
    descTplInput.addEventListener("change", save);

    /* ---- 补图工作流：能进画布改、能恢复内置 ---- */

    const wfBox = el("div", { class: "cw-rows" }, [
      el("div", { class: "cw-hint", text: "读取中…" }),
    ]);

    const loadWorkflows = async () => {
      try {
        const data = await cwApi.supplementPresets();
        wfBox.replaceChildren();
        for (const p of data.presets || []) {
          const bad = !p.available;
          const row = el("div", { class: "cw-wf-row" }, [
            el("div", { class: "cw-wf-main" }, [
              el("div", { class: "cw-wf-name" }, [
                el("b", { text: p.label }),
                p.edited ? el("span", { class: "cw-wf-tag", text: "已改过" }) : null,
                bad ? el("span", { class: "cw-wf-tag is-bad", text: "模型不全" }) : null,
              ]),
              el("div", {
                class: "cw-wf-hint",
                text: bad
                  ? (p.missing || []).join("；")
                  : p.mode === "t2i"
                    ? "文生图 · 用来画底稿"
                    : p.mode === "sheet"
                      ? "整表 · 一次出多视图"
                      : "逐张 · 单张可重跑",
              }),
            ]),
            el("div", { class: "cw-wf-actions" }, [
              el("button", {
                class: "cw-btn-mini",
                type: "button",
                text: "编辑",
                title: bad ? "模型不全也能改节点，但跑不了" : "载入画布修改",
                onclick: async () => {
                  this.close();
                  await openPresetEditor(p.id, p.label);
                },
              }),
              p.edited
                ? el("button", {
                    class: "cw-btn-mini",
                    type: "button",
                    text: "恢复内置",
                    onclick: async () => {
                      if (!window.confirm(`把「${p.label}」恢复成内置版本？`)) return;
                      try {
                        await cwApi.presetReset(p.id);
                        toast("已恢复内置");
                        loadWorkflows();
                      } catch (e) {
                        toast(e.message);
                      }
                    },
                  })
                : null,
            ]),
          ]);
          wfBox.append(row);
        }
        if (!(data.presets || []).length) {
          wfBox.append(el("div", { class: "cw-hint", text: "没有可用的补图预设" }));
        }
      } catch (e) {
        wfBox.replaceChildren(el("div", { class: "cw-hint", text: `读取失败：${e.message}` }));
      }
    };
    loadWorkflows();

    this.bodyEl.replaceChildren(
      el("div", { class: "cw-section-title", text: "引用标记" }),
      el("div", { class: "cw-rows", style: "margin-bottom:26px" }, [
        el("div", { class: "cw-row", style: "flex-direction:column;align-items:stretch" }, [
          el("label", { text: "模板", style: "font-size:11.5px;color:var(--cw-text-dim)" }),
          templateInput,
          el("div", { class: "cw-hint" }, [
            "@ 引用会被替换成这个模板。",
            el("code", { text: "{n}" }),
            " 是从 1 开始的序号，",
            el("code", { text: "{i}" }),
            " 从 0 开始。",
            el("br"),
            "Qwen Image 2.1 填 ",
            el("code", { text: "image {n}" }),
            "；MiniMax H3 填 ",
            el("code", { text: "<Picture {n}>" }),
            "；Flux 2 Klein 一般用纯文字 ",
            el("code", { text: "image {n}" }),
            "。",
          ]),
        ]),
        el("div", { class: "cw-row", style: "flex-direction:column;align-items:stretch" }, [
          el("label", { text: "参考图最大像素（百万）", style: "font-size:11.5px;color:var(--cw-text-dim)" }),
          mpInput,
          el("div", { class: "cw-hint" }, [
            "超过就等比缩小。8G 显存建议 1.0，别调太高。",
          ]),
        ]),
        el("div", { class: "cw-row" }, [
          extrasBox,
          el("span", { text: "引用一张卡时，把它的补充图也一起送出去" }),
        ]),
      ]),
      el("div", { class: "cw-section-title", text: "角色设定" }),
      el("div", { class: "cw-rows" }, [
        el("div", { class: "cw-row", style: "flex-direction:column;align-items:stretch" }, [
          el("label", { text: "发送策略", style: "font-size:11.5px;color:var(--cw-text-dim)" }),
          descSelect,
          el("div", { class: "cw-hint" }, [
            "卡片里写的设定，会以「",
            el("code", { text: "image 1 是阿离。外观：…" }),
            "」这种形式",
            el("b", { text: "整块放在提示词最前面" }),
            "，",
            el("code", { text: "@阿离" }),
            " 在句子里仍然只显示成 ",
            el("code", { text: "image 1" }),
            "。",
            el("br"),
            "身份锚定是补丁不是主干：它在你参考图角度不全、被遮挡、离得远时补位，",
            "救不了参考图本身不够的情况。多补两张侧脸/全身比多写两百字管用。",
          ]),
        ]),
        el("div", { class: "cw-row", style: "flex-direction:column;align-items:stretch" }, [
          el("label", { text: "设定模板", style: "font-size:11.5px;color:var(--cw-text-dim)" }),
          descTplInput,
          el("div", { class: "cw-hint" }, [
            el("code", { text: "{ref}" }),
            " 引用标记 · ",
            el("code", { text: "{name}" }),
            " 卡名 · ",
            el("code", { text: "{identity}" }),
            " 身份锚定 · ",
            el("code", { text: "{variable}" }),
            " 可变项 · ",
            el("code", { text: "{detail}" }),
            " 详细设定 · ",
            el("code", { text: "{n}" }),
            "/",
            el("code", { text: "{i}" }),
            " 序号。",
            el("br"),
            "某个占位符为空时会自动清掉留下的空壳（「外观：。」这种）。",
          ]),
        ]),
      ]),
      el("div", { class: "cw-section-title", text: "补图工作流" }),
      wfBox,
      el("div", { class: "cw-hint", style: "margin-top:8px" }, [
        "「编辑」会把工作流载进 ComfyUI 画布，改完点「保存」即刻生效；",
        "返回时会自动还原你原来的画布（进去前已备份）。",
        el("br"),
        "想让某个视图换成别的构图？改对应节点的提示词，或者直接加节点 —— 只要还有 SaveImage 就能跑。",
      ])
    );
  }

  /* ---------- 编辑抽屉 ---------- */

  openEditor(cardId, { fresh = false } = {}) {
    this.editingId = cardId;
    this.closeEditor();
    this.root.classList.add("cw-has-drawer");

    const render = () => {
      const card = store.card(cardId);
      if (!card) {
        this.closeEditor();
        return;
      }

      const drop = el("div", { class: "cw-drop", title: "点击或拖入图片" });
      if (card.main) {
        drop.append(
          el("img", {
            src: assetUrl(card.main, store.bustOf(card.id)),
            alt: "",
          })
        );
      } else {
        drop.append(
          el("div", { class: "cw-drop-hint" }, [
            el("b", { text: "放一张主图" }),
            "点击选择，或直接把图拖进来",
          ])
        );
      }

      const uploadTo = async (file, slot) => {
        if (!file) return;
        drop.dataset.over = "0";
        try {
          await cwApi.upload(file, { cardId: card.id, slot, name: card.name });
          store.bust(card.id);
          await store.refresh();
          render();
          this.renderGrid();
        } catch (e) {
          toast(`上传失败：${e.message}`);
        }
      };

      drop.addEventListener("click", async () => {
        const file = await pickFile();
        if (file) uploadTo(file, "main");
      });
      drop.addEventListener("dragover", (e) => {
        e.preventDefault();
        drop.dataset.over = "1";
      });
      drop.addEventListener("dragleave", () => (drop.dataset.over = "0"));
      drop.addEventListener("drop", (e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file) uploadTo(file, "main");
      });

      const nameInput = el("input", { class: "cw-input", value: card.name || "" });
      nameInput.addEventListener("change", async () => {
        const name = nameInput.value.trim();
        if (!name || name === card.name) return;
        try {
          await cwApi.updateCard(card.id, { name });
          await store.refresh();
          this.renderGrid();
          toast("名字已改");
        } catch (e) {
          toast(e.message);
        }
      });

      const catSelect = el(
        "select",
        { class: "cw-select" },
        [
          el("option", { value: "", text: "未分类" }),
          ...store.categories.map((c) =>
            el("option", { value: c.id, text: c.name, selected: c.id === card.categoryId })
          ),
          el("option", { value: "__new", text: "＋ 新建分类…" }),
        ]
      );
      catSelect.value = card.categoryId || "";
      catSelect.addEventListener("change", async () => {
        // 选「新建分类」时当场建一个并把卡放进去，不用退回标签栏
        if (catSelect.value === "__new") {
          catSelect.value = card.categoryId || "";
          const spec = await askCategory(null);
          if (!spec) return;
          try {
            const cat = await cwApi.addCategory({ name: spec.name, color: spec.color });
            await cwApi.updateCard(card.id, { categoryId: cat.id });
            await store.refresh();
            this.openEditor(card.id);
            this.renderGrid();
            toast(`已新建分类「${cat.name}」并归入`);
          } catch (e) {
            toast(e.message);
          }
          return;
        }
        try {
          await cwApi.updateCard(card.id, { categoryId: catSelect.value });
          await store.refresh();
          this.render();
        } catch (e) {
          toast(e.message);
        }
      });

      const noteInput = el("textarea", {
        class: "cw-textarea",
        placeholder: "给自己看的一句话备注",
      });
      noteInput.value = card.note || "";
      noteInput.addEventListener("change", async () => {
        try {
          await cwApi.updateCard(card.id, { note: noteInput.value });
          await store.refresh();
        } catch (e) {
          toast(e.message);
        }
      });

      /* ---- 角色设定：让 @名字 背后是一整套信息，而不只是一张图 ---- */

      // 只改本地对象 + 落盘，不整块重绘 —— 否则每敲一次就丢焦点
      const saveDesc = async (patch) => {
        try {
          await cwApi.updateCard(card.id, patch);
          Object.assign(card, patch);
          store.emit("cards");   // 节点上的芯片小点、卡片上的标记跟着变
        } catch (e) {
          toast(`保存失败：${e.message}`);
        }
      };

      const descInner = el("div", {
        class: "cw-desc-inner",
        dataset: { off: card.descOn === false ? "1" : "0" },
      });

      const descField = (key, label, hint, rows, placeholder) => {
        const ta = el("textarea", {
          class: "cw-textarea cw-textarea-sm",
          rows: String(rows),
          placeholder,
          spellcheck: "false",
        });
        ta.value = card[key] || "";
        ta.addEventListener("change", () => saveDesc({ [key]: ta.value.trim() }));
        return el("div", { class: "cw-desc-field" }, [
          el("div", { class: "cw-desc-label" }, [
            el("span", { text: label }),
            hint ? el("em", { text: hint }) : null,
          ]),
          ta,
        ]);
      };

      const descToggle = el("input", { type: "checkbox", class: "cw-check" });
      descToggle.checked = card.descOn !== false;
      descToggle.addEventListener("change", () => {
        saveDesc({ descOn: descToggle.checked });
        descInner.dataset.off = descToggle.checked ? "0" : "1";
      });

      const modeLabel =
        {
          off: "不发送",
          core: "身份锚定 + 可变项",
          full: "全部，含详细设定",
        }[store.settings.descMode || "core"] || "身份锚定 + 可变项";

      descInner.append(
        descField(
          "identity",
          "身份锚定",
          "最有效的一栏。只写看得见的东西",
          2,
          "黑长直、琥珀瞳、左眼下泪痣、米色针织衫"
        ),
        descField(
          "variable",
          "可变项",
          "说清哪些能改，它才不会乱改或不敢改",
          2,
          "保持面部特征与发型不变，可换服装与场景"
        ),
        descField(
          "detail",
          "详细设定",
          "人设 / 经历 / 口头禅。默认不送模型，只当资料",
          4,
          "十七岁，剑术学徒，说话很轻，习惯把左手藏在袖子里……"
        )
      );

      const descSection = el("div", { class: "cw-desc" }, [
        el("div", { class: "cw-desc-head" }, [
          el("label", { class: "cw-desc-toggle" }, [
            descToggle,
            el("span", { text: "「@这张卡」时，把设定一起送给模型" }),
          ]),
          el("button", {
            class: "cw-desc-mode",
            text: `全局：${modeLabel} ▸`,
            title: "到设置里改发送策略",
            onclick: () => this.switchTab("settings"),
          }),
        ]),
        el("div", { class: "cw-desc-tip" }, [
          "只写看得见的东西。性格、经历塞进「详细设定」别塞进身份锚定 —— ",
          el("b", { text: "长段外貌描写会把人物往「描述中的样子」拉，反而更容易漂。" }),
        ]),
        descInner,
      ]);

      const extras = card.extras || [];
      const extraNodes = extras.map((ex) =>
        el("div", { class: "cw-extra" }, [
          el("img", { src: assetUrl(ex.thumb || ex.file, store.bustOf(card.id)), alt: "" }),
          el("button", {
            text: "×",
            title: "移除",
            onclick: async () => {
              try {
                await cwApi.deleteExtra(card.id, ex.file);
                store.bust(card.id);
                await store.refresh();
                render();
                this.renderGrid();
              } catch (e) {
                toast(e.message);
              }
            },
          }),
        ])
      );

      const addExtra = el("div", {
        class: "cw-extra-add",
        text: "＋",
        title: "添加补充图（选图后可以框选）",
        onclick: async () => {
          const file = await pickFile();
          if (!file) return;
          // 这里有框选，不是把原图直接塞进去：素材常常是一整张设定表，
          // 不裁就会把别人的脸、说明文字一起挂进卡里，以后当参考图反而污染身份。
          let blob;
          try {
            blob = await openCrop(file, { title: "框出要补的部分", aspect: 0 });
          } catch (e) {
            return toast(e.message || "这张图读不出来");
          }
          if (!blob) return;
          await uploadTo(
            new File([blob], "extra.png", { type: blob.type || "image/png" }),
            "extra"
          );
        },
      });

      const stagedBtn = el("button", {
        class: "cw-btn-lg",
        text: store.isStaged(card.id) ? "从工作台撤下" : "放到工作台",
        onclick: async () => {
          await this.toggleStage(card.id);
          render();
        },
      });

      // 标记色：决定上台后的卡片颜色，也决定提示词里 @名字 的显示颜色
      const colorRow = el("div", { class: "cw-swatches cw-swatches-sm" }, [
        el("button", {
          class: "cw-swatch cw-swatch-none",
          title: "不标记",
          dataset: { on: card.color ? "0" : "1" },
          text: "无",
          onclick: async () => {
            try {
              await cwApi.updateCard(card.id, { color: "" });
              await store.refresh();
              render();
              this.renderGrid();
            } catch (e) {
              toast(e.message);
            }
          },
        }),
        ...PALETTE.map((color) =>
          el("button", {
            class: "cw-swatch",
            title: color,
            style: `background:${color}`,
            dataset: { on: card.color === color ? "1" : "0" },
            onclick: async () => {
              try {
                await cwApi.updateCard(card.id, { color });
                await store.refresh();
                render();
                this.renderGrid();
              } catch (e) {
                toast(e.message);
              }
            },
          })
        ),
      ]);

      const body = el("div", { class: "cw-drawer-body" }, [
        drop,
        el("div", { class: "cw-field" }, [el("label", { text: "名字" }), nameInput]),
        el("div", { class: "cw-field" }, [el("label", { text: "分类" }), catSelect]),
        el("div", { class: "cw-field" }, [el("label", { text: "标记色（工作台 / @ 显示颜色）" }), colorRow]),
        descSection,
        el("div", { class: "cw-field" }, [
          el("label", { class: "cw-label-row" }, [
            el("span", { text: "补充图（可选）" }),
            el("button", {
              class: "cw-btn-mini",
              text: "AI 补图",
              onclick: () => {
                // 补图是往这张卡的补充图里加，所以门就开在这
                openSupplement(card.id);
              },
            }),
            el("button", {
              class: "cw-btn-mini cw-danger",
              text: "清理冗余图",
              title: "删掉这张卡目录里已不被引用的图片（替换残留 / 多余生成图），不影响正在使用的图",
              onclick: async () => {
                let orphans;
                try {
                  orphans = await cwApi.cardOrphans(card.id);
                } catch (e) {
                  return toast("读取冗余图失败：" + e.message);
                }
                if (!orphans.length) {
                  return toast("没有多余的图，目录是干净的");
                }
                const ok = await askConfirm({
                  title: "清理冗余图",
                  message: `找到 ${orphans.length} 张已不被引用的图，删掉不影响卡片使用。确认清理？`,
                  confirm: "清理",
                  danger: true,
                });
                if (!ok) return;
                try {
                  const r = await cwApi.cardPrune(card.id);
                  toast(`已清理 ${r.removed} 张冗余图`);
                } catch (e) {
                  toast("清理失败：" + e.message);
                }
              },
            }),
          ]),
          el("div", { class: "cw-extras" }, [...extraNodes, addExtra]),
        ]),
        el("div", { class: "cw-field" }, [el("label", { text: "备注" }), noteInput]),
      ]);

      const drawer = el("aside", { class: "cw-drawer" }, [
        el("div", { class: "cw-drawer-head" }, [
          el("b", { text: fresh ? "新建卡 · 先放张图" : "编辑卡片" }),
          el("button", { class: "cw-iconbtn", text: "✕", onclick: () => this.closeEditor() }),
        ]),
        body,
        el("div", { class: "cw-drawer-foot" }, [
          stagedBtn,
          el("button", {
            class: "cw-btn-lg cw-primary",
            text: "完成",
            onclick: () => this.closeEditor(),
          }),
        ]),
      ]);

      const old = this.modal.querySelector(".cw-drawer");
      if (old) old.replaceWith(drawer);
      else this.modal.append(drawer);
      this.drawerEl = drawer;
    };

    this._drawerRender = render;
    render();
  }

  closeEditor() {
    this.editingId = null;
    this.drawerEl?.remove();
    this.drawerEl = null;
    this.root?.classList.remove("cw-has-drawer");
  }
}

/* -------------------------------------------------------------------------
   对外
   ------------------------------------------------------------------------- */

let panel = null;

export async function openLibrary(tab) {
  injectStyle();
  if (!panel) panel = new LibraryPanel();
  await panel.open(tab);
}

export function isLibraryOpen() {
  return !!panel?.isOpen;
}
