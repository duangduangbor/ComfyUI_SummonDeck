/**
 * 怪兽牌组 —— 新建角色
 *
 * 一个角色的起点只有两件事：叫什么、长什么样。别的都是后话。
 * 所以这个弹窗刻意做得很短：名字 + 底稿。分类顺手选一个。
 *
 * 底稿两条路：
 *   1) 从本地选一张 —— 进裁切器，自己框范围（素材常常是一整张拼图）
 *   2) 让 AI 画一张 —— 先建卡再文生图，画出来的直接当底稿
 * 两条路的产物都落在同一处：卡片的 main，之后所有补图都以它为参考。
 */

import { cwApi, el, isDarkTheme, store, toast } from "./cw-core.js";
import { openCrop } from "./cw-crop.js";

function pickFile(accept = "image/*") {
  return new Promise((resolve) => {
    const input = el("input", { type: "file", accept, style: "display:none" });
    input.addEventListener("change", () => {
      resolve(input.files?.[0] || null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

const RATIOS = [
  { id: "portrait", label: "竖构图（全身）" },
  { id: "square", label: "方形" },
  { id: "landscape", label: "横构图" },
];

export function openNewCard({ categories = [], defaultCategoryId = "" } = {}) {
  return new Promise((resolve) => {
    const state = {
      name: "",
      categoryId: defaultCategoryId || categories[0]?.id || "",
      blob: null,
      aiMode: false,
      subject: "",
      ratio: "portrait",
      cardId: "",
      busy: false,
      pollTimer: null,
    };

    /* ---------------- 名字 ---------------- */

    const nameInput = el("input", {
      class: "cw-input",
      placeholder: "阿离 / 雨夜街头 / 旧相机",
      autofocus: true,
    });
    nameInput.addEventListener("input", () => {
      state.name = nameInput.value.trim();
      syncCreateState();
    });

    const catSelect = el("select", { class: "cw-select" });
    for (const c of categories) {
      catSelect.append(el("option", { value: c.id, text: c.name }));
    }
    catSelect.value = state.categoryId;
    catSelect.addEventListener("change", () => {
      state.categoryId = catSelect.value;
    });

    /* ---------------- 底稿区 ---------------- */

    const coverBox = el("div", { class: "cw-nc-cover" });
    const coverHint = el("div", { class: "cw-nc-cover-hint" });

    const renderCover = () => {
      coverBox.replaceChildren();
      coverBox.dataset.empty = state.blob ? "0" : "1";

      if (state.blob) {
        const url = URL.createObjectURL(state.blob);
        const img = el("img", { src: url, alt: "" });
        img.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
        coverBox.append(img);
        coverBox.append(
          el("div", { class: "cw-nc-cover-tools" }, [
            el("button", {
              class: "cw-btn-mini",
              type: "button",
              text: "重新裁切",
              onclick: async (e) => {
                e.stopPropagation();
                const again = await openCrop(state.blob, { title: "重新裁切" });
                if (again) {
                  state.blob = again;
                  renderCover();
                }
              },
            }),
            el("button", {
              class: "cw-btn-mini",
              type: "button",
              text: "换一张",
              onclick: async (e) => {
                e.stopPropagation();
                await chooseFile();
              },
            }),
          ])
        );
        coverHint.textContent = "这张就是底稿，之后所有补图都以它为参考";
      } else if (state.aiMode) {
        coverBox.append(
          el("div", { class: "cw-nc-cover-ai" }, [
            el("b", { text: "让 AI 画一张底稿" }),
            "描述得具体一点：谁、穿什么、什么气质。画出来不满意可以重画。",
          ])
        );
        coverHint.textContent = "画好后会直接变成这张卡的底稿";
      } else {
        coverBox.append(
          el("div", { class: "cw-nc-cover-hint" }, [
            el("b", { text: "点这里选一张图" }),
            "也可以把图直接拖进来",
          ])
        );
        coverHint.textContent = "一整张拼图也没关系 —— 选完会让你自己框出要用的那块";
      }
    };

    const chooseFile = async () => {
      const file = await pickFile();
      if (!file) return;
      const cropped = await openCrop(file, { title: "框出这个角色的部分" });
      if (!cropped) return;
      state.blob = cropped;
      state.aiMode = false;
      renderCover();
      syncCreateState();
    };

    coverBox.addEventListener("click", () => {
      if (state.blob) return;
      if (state.aiMode) return;
      chooseFile();
    });
    coverBox.addEventListener("dragover", (e) => {
      e.preventDefault();
      coverBox.classList.add("is-over");
    });
    coverBox.addEventListener("dragleave", () => coverBox.classList.remove("is-over"));
    coverBox.addEventListener("drop", async (e) => {
      e.preventDefault();
      coverBox.classList.remove("is-over");
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const cropped = await openCrop(file, { title: "框出这个角色的部分" });
      if (!cropped) return;
      state.blob = cropped;
      state.aiMode = false;
      renderCover();
      syncCreateState();
    });

    /* ---------------- AI 面板 ---------------- */

    const aiToggle = el("button", {
      class: "cw-nc-ai-toggle",
      type: "button",
      text: "没有现成图？让 AI 画一张",
      onclick: () => {
        state.aiMode = !state.aiMode;
        state.blob = null;
        aiToggle.textContent = state.aiMode
          ? "还是自己上传一张"
          : "没有现成图？让 AI 画一张";
        aiPanel.style.display = state.aiMode ? "" : "none";
        renderCover();
        syncCreateState();
      },
    });

    const subjectInput = el("textarea", {
      class: "cw-textarea",
      placeholder: "例：十七岁剑术学徒，黑长直，琥珀色眼睛，米色针织衫配深色长裤，气质清冷",
    });
    subjectInput.addEventListener("input", () => {
      state.subject = subjectInput.value.trim();
      syncCreateState();
    });

    const ratioRow = el("div", { class: "cw-nc-ratios" });
    const ratioBtns = RATIOS.map((r) => {
      const btn = el("button", {
        class: "cw-sup-view" + (r.id === state.ratio ? " is-on" : ""),
        type: "button",
        text: r.label,
        onclick: () => {
          state.ratio = r.id;
          for (const b of ratioBtns) b.classList.remove("is-on");
          btn.classList.add("is-on");
        },
      });
      ratioRow.append(btn);
      return btn;
    });

    const aiPanel = el("div", { class: "cw-nc-ai", style: "display:none" }, [
      subjectInput,
      ratioRow,
      el("div", { class: "cw-hint", text: "生成需要一到几分钟，模型加载完第一张会快一些" }),
    ]);

    /* ---------------- 底部 ---------------- */

    const cancelBtn = el("button", { class: "cw-btn-ghost", type: "button", text: "取消" });
    const createBtn = el("button", { class: "cw-btn-lg", type: "button", text: "创建" });
    const statusLine = el("div", { class: "cw-nc-status" });

    const needName = () => !state.name;
    const canCreate = () => {
      if (state.busy) return false;
      if (needName()) return false;
      if (state.aiMode) return !!state.subject;
      return !!state.blob;
    };

    function syncCreateState() {
      createBtn.disabled = !canCreate();
      createBtn.textContent = state.aiMode ? "创建并画底稿" : "创建";
      if (needName()) statusLine.textContent = "先给它起个名字";
      else if (!state.aiMode && !state.blob) statusLine.textContent = "再选一张底稿";
      else if (state.aiMode && !state.subject) statusLine.textContent = "写一句想画什么";
      else statusLine.textContent = "";
    }

    /* ---------------- 提交 ---------------- */

    const ensureCard = async () => {
      if (state.cardId) return state.cardId;
      const card = await cwApi.createCard({
        name: state.name,
        categoryId: state.categoryId,
      });
      state.cardId = card.id;
      await store.refresh();
      return card.id;
    };

    const uploadCover = async (cardId) => {
      const file = new File([state.blob], "cover.png", { type: "image/png" });
      await cwApi.upload(file, { cardId, slot: "main", name: state.name });
      await cwApi.updateCard(cardId, { coverSource: "upload" });
      await store.refresh();
    };

    const pollJob = async (jobId) => {
      const snap = await cwApi.supplementJob(jobId);
      if (!snap) throw new Error("任务丢了");
      const item = snap.items?.[0] || {};
      if (snap.status === "done") return snap;
      if (snap.status === "failed" || snap.status === "cancelled") {
        throw new Error(item.error || "生成失败");
      }
      const stage =
        item.stage === "sampling" ? "正在画…" : item.stage === "submitting" ? "提交中…" : "准备中…";
      statusLine.textContent = stage;
    };

    const waitJob = (jobId) =>
      new Promise((resolve, reject) => {
        const tick = async () => {
          try {
            await pollJob(jobId).then((snap) => {
              if (snap.status === "done") return resolve(snap);
            });
            // pollJob 抛错时走 catch
          } catch (e) {
            clearInterval(state.pollTimer);
            state.pollTimer = null;
            return reject(e);
          }
        };
        state.pollTimer = setInterval(tick, 2500);
        tick();
      });

    const close = (result) => {
      if (state.pollTimer) clearInterval(state.pollTimer);
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      resolve(result);
    };

    cancelBtn.addEventListener("click", async () => {
      if (state.pollTimer) clearInterval(state.pollTimer);
      // 已经建了卡又中途取消，就把空卡删掉，别在库里留垃圾
      if (state.cardId && !state.blob) {
        try {
          const card = store.card(state.cardId);
          if (!card || !card.main) await cwApi.deleteCard(state.cardId);
        } catch (e) {
          /* 删不掉也不影响主流程 */
        }
      }
      close(null);
    });

    createBtn.addEventListener("click", async () => {
      if (!canCreate()) return;
      state.busy = true;
      syncCreateState();
      createBtn.textContent = state.aiMode ? "画底稿中…" : "创建中…";

      try {
        const cardId = await ensureCard();

        if (state.aiMode) {
          const presets = await cwApi.supplementPresets();
          const preset = (presets.presets || []).find(
            (p) => p.mode === "t2i" && p.available
          );
          if (!preset) {
            throw new Error("没有可用的底稿生成模型（缺 Qwen-Image 一类）");
          }
          statusLine.textContent = "提交中…";
          const job = await cwApi.coverGenerate({
            cardId,
            presetId: preset.id,
            subject: state.subject,
            ratio: state.ratio,
          });
          await waitJob(job.id);
          await store.refresh();
          toast("底稿画好了");
        } else {
          await uploadCover(cardId);
          toast("创建完成");
        }

        const card = store.card(cardId);
        close(card || { id: cardId, name: state.name });
      } catch (e) {
        statusLine.textContent = `失败：${e.message}`;
        createBtn.textContent = "重试";
        state.busy = false;
        syncCreateState();
      }
    });

    const onKey = (e) => {
      if (e.key === "Escape" && !state.busy) {
        e.stopPropagation();
        cancelBtn.click();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        createBtn.click();
      }
    };
    document.addEventListener("keydown", onKey, true);

    /* ---------------- 组装 ---------------- */

    const panel = el("div", { class: "cw-nc-panel" }, [
      el("div", { class: "cw-nc-head" }, [
        el("div", {}, [
          el("b", { text: "新建角色" }),
          el("span", { class: "cw-nc-sub", text: "先定名字和底稿，其余后面补" }),
        ]),
      ]),
      el("div", { class: "cw-nc-body" }, [
        el("div", { class: "cw-field" }, [
          el("label", { text: "名字（提示词里就是 @这个名字）" }),
          nameInput,
        ]),
        el("div", { class: "cw-field" }, [
          el("label", { text: "分类" }),
          catSelect,
        ]),
        el("div", { class: "cw-field" }, [
          el("label", { text: "底稿（相当于这张卡的封面）" }),
          coverBox,
          coverHint,
          aiToggle,
          aiPanel,
        ]),
      ]),
      el("div", { class: "cw-nc-foot" }, [statusLine, el("div", { class: "cw-nc-actions" }, [cancelBtn, createBtn])]),
    ]);

    const mask = el("div", { class: "cw-nc-mask" }, [panel]);
    if (isDarkTheme()) mask.classList.add("cw-dark");
    document.body.append(mask);

    renderCover();
    syncCreateState();
    setTimeout(() => nameInput.focus(), 60);
  });
}
