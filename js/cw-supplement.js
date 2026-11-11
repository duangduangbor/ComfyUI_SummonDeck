/**
 * 怪兽牌组 —— AI 补图面板
 *
 * 入口：openSupplement(cardId)
 *
 * 它解决的是角色漂移的第一主因：**参考图角度覆盖不足**。
 * 一张只有正面的卡，@ 出去模型只能瞎猜侧面和背面；
 * 补一张多视图设定表，比写两百字外貌描述管用得多。
 *
 * 两种模式在这里合流：
 *   sheet —— 一次出一整张设定表（FLUX2 QuadView / Krea2 DynamicSheet）
 *   set   —— 每个视图独立出图，单张不满意就重跑那一张
 */

import { cwApi, el, toast, assetUrl, isDarkTheme } from "./cw-core.js";
import { openPresetEditor } from "./cw-wfedit.js";
import { openCrop } from "./cw-crop.js";

const VIEW_LABELS = {
  face: "面部特写",
  front: "正面全身",
  three_q: "四分之三侧",
  side: "侧面全身",
  back: "背面全身",
  action: "动作姿态",
  expression: "表情集",
};

/** 挑一张本机图片。选完就把 input 摘掉，不留 DOM 垃圾。 */
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

function isSupplementExtra(e) {
  // 早期数据只写了 view 没写 source，别把它们判成"不存在"
  return e.source === "supplement" || e.source === "upload" || (!e.source && !!e.view);
}

let pollTimer = null;
let escHandler = null;

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/** 摘掉可能还挂着的旧面板，连带解绑它的 Esc —— 否则重复打开会叠层、事件越积越多。 */
function clearOldPanel() {
  document.querySelectorAll(".cw-sup-mask").forEach((m) => m.remove());
  if (escHandler) {
    document.removeEventListener("keydown", escHandler, true);
    escHandler = null;
  }
}

function mount(mask) {
  const shell = document.querySelector(".cw-shell");
  (shell || document.body).append(mask);
  return mask;
}

/* -------------------------------------------------------------------------
   主流程
   ------------------------------------------------------------------------- */

export async function openSupplement(cardId) {
  stopPolling();
  clearOldPanel();

  let lib, presets, active = null;
  try {
    [lib, presets, active] = await Promise.all([
      cwApi.getLibrary(),
      cwApi.supplementPresets(),
      // 面板能被关掉，任务不会 —— 关掉再打开要能把界面接回正在跑的那个任务
      cwApi.supplementActive(cardId).catch(() => null),
    ]);
  } catch (e) {
    toast(`读取补图能力失败：${e.message}`);
    return;
  }

  const card = (lib.cards || []).find((c) => c.id === cardId);
  if (!card) {
    toast("卡片不存在");
    return;
  }

  // 底稿生成类预设（t2i）不在这里出现 —— 它们没有参考图可依
  presets = { ...presets, presets: (presets.presets || []).filter((p) => p.mode !== "t2i") };

  /* ---------- 状态 ---------- */
  const st = {
    presetId: (presets.presets.find((p) => p.available) || {}).id || "",
    views: new Set(),
    identity: card.identity || "",
    extra: "",
    job: null,
    running: false,
    // 每个角度「该长什么样」。文案在 presets.py 的 VIEW_GUIDES 里，
    // 和后端真正喂给模型的 edit 指令同源，不会各说各话。
    viewInfo: presets.viewInfo || {},
    // 这张卡已经补过的图。面板关掉再打开时，这里必须还在 ——
    // 否则用户看不见上次的成果，也没法在已有角度上继续补。
    extras: (card.extras || []).filter(isSupplementExtra),
  };

  /** 取视图说明，后端没给就退回本地标签 */
  const viewInfoOf = (v) => {
    const info = st.viewInfo[v] || {};
    return {
      key: v,
      label: info.label || VIEW_LABELS[v] || v,
      guide: info.guide || "",
      aspect: info.aspect || [1, 1],
    };
  };

  const curPreset = () => presets.presets.find((p) => p.id === st.presetId) || null;

  /* ---------- 骨架 ---------- */
  const presetBox = el("div", { class: "cw-sup-presets" });
  const viewBox = el("div", { class: "cw-sup-views" });
  const viewHint = el("div", { class: "cw-hint cw-sup-viewhint" });
  const viewWrap = el("div", { class: "cw-sup-sec" }, [
    el("div", { class: "cw-sup-sec-title", text: "出哪几个视图" }),
    viewBox,
    viewHint,
  ]);
  const identInput = el("textarea", {
    class: "cw-textarea cw-sup-ident",
    placeholder: "发色 / 发型 / 瞳色 / 体型 / 标志性配饰，用逗号分隔",
    rows: "3",
  });
  identInput.value = st.identity;

  const identHint = el("div", { class: "cw-hint" });

  const resultBox = el("div", { class: "cw-sup-results" });
  const resultWrap = el("div", { class: "cw-sup-sec cw-sup-resultsec", style: "display:none" }, [
    el("div", { class: "cw-sup-sec-title", text: "本次结果" }),
    resultBox,
  ]);

  // 这张卡以前补过的图。不显示它，用户就不知道哪些角度已经有了，
  // 容易把同一个角度补三遍，也点不到「重跑这张」。
  const ownedBox = el("div", { class: "cw-sup-results" });
  const ownedWrap = el("div", { class: "cw-sup-sec cw-sup-ownedsec", style: "display:none" }, [
    el("div", { class: "cw-sup-sec-title", text: "已补过的图" }),
    ownedBox,
  ]);

  const startBtn = el("button", { class: "cw-btn-lg cw-primary", text: "开始补图" });
  const statusLine = el("div", { class: "cw-sup-status" });
  const closeBtn = el("button", { class: "cw-iconbtn", text: "✕" });
  const wfBtn = el("button", {
    class: "cw-btn-mini cw-sup-wfbtn",
    type: "button",
    text: "编辑工作流",
    title: "把当前这套做法载入画布，改节点 / 换 LoRA / 调步数",
    onclick: () => {
      const p = curPreset();
      if (!p) return toast("先选一套做法");
      close();
      openPresetEditor(p.id, p.label);
    },
  });

  const identWrap = el("div", { class: "cw-sup-sec" }, [
    el("div", { class: "cw-sup-sec-title", text: "身份描述" }),
    identInput,
    identHint,
  ]);

  // 顺序是「我缺什么 → 我已经有什么 → 这次出了什么 → 参数」。
  // 「已补过的图」必须紧跟视图，不能压在身份描述后面 ——
  // 一行行视图加上引导之后面板变长了，它在下面就得滚动才看得到，
  // 而用户最想确认的恰恰是"我刚补的那张到底进没进卡"。
  const bodyEl = el("div", { class: "cw-sup-body" }, [
    el("div", { class: "cw-sup-sec" }, [
      el("div", { class: "cw-sup-sec-title", text: "选一套做法" }),
      presetBox,
    ]),
    viewWrap,
    ownedWrap,
    resultWrap,
    identWrap,
  ]);

  const panel = el("div", { class: "cw-sup-panel" }, [
    el("div", { class: "cw-sup-head" }, [
      el("div", {}, [
        el("b", { text: "AI 补图" }),
        el("span", { class: "cw-sup-sub", text: card.name || "" }),
      ]),
      el("div", { class: "cw-sup-head-right" }, [wfBtn, closeBtn]),
    ]),
    bodyEl,
    el("div", { class: "cw-sup-foot" }, [statusLine, startBtn]),
  ]);

  // 这个面板可能从卡库打开（那里已有 .cw-shell 变量），也可能单独出现，
  // 所以自带一套主题变量，不依赖外部容器
  const mask = el("div", {
    class: "cw-sup-mask" + (isDarkTheme() ? " cw-dark" : ""),
  }, [panel]);
  mount(mask);

  /* ---------- 渲染：预设 ---------- */

  const renderPresets = () => {
    presetBox.replaceChildren();
    if (!presets.presets.length) {
      presetBox.append(el("div", { class: "cw-hint", text: "没有可用的补图预设" }));
      return;
    }
    for (const p of presets.presets) {
      const active = p.id === st.presetId;
      const modeTag = p.mode === "sheet" ? "整表" : "逐张";

      const node = el("button", {
        class: "cw-sup-preset" + (active ? " is-on" : "") + (p.available ? "" : " is-off"),
        disabled: !p.available,
        onclick: () => {
          if (!p.available) return;
          st.presetId = p.id;
          st.views = new Set();
          renderPresets();
          renderViews();
        },
      }, [
        el("div", { class: "cw-sup-preset-top" }, [
          el("b", { text: p.label }),
          el("span", { class: "cw-sup-tag", text: modeTag }),
          p.edited ? el("span", { class: "cw-sup-tag is-edit", text: "已改过" }) : null,
        ]),
        el("div", { class: "cw-sup-preset-hint", text: p.hint || "" }),
        p.available
          ? null
          : el("div", { class: "cw-sup-miss", text: "缺：" + (p.missing || []).join("；") }),
      ]);
      presetBox.append(node);
    }
  };

  /* ---------- 渲染：视图 ---------- */

  const toggleView = (v) => {
    if (st.views.has(v)) st.views.delete(v);
    else st.views.add(v);
    renderViews();
  };

  /**
   * 手动补一张：选图 → 裁切（按这个角度的推荐比例）→ 上传进 extras。
   *
   * 为什么手动补也要裁：素材常常是一整张设定表，不裁就会把别人的脸也带进去，
   * 以后当参考图用时反而污染身份。裁切框的默认比例跟 AI 出的那张一致，
   * 这样同一个角度里，AI 出的和手传的可以互换。
   */
  const uploadForView = async (v) => {
    const info = viewInfoOf(v);
    const file = await pickFile();
    if (!file) return;

    const [aw, ah] = info.aspect || [1, 1];
    let blob;
    try {
      blob = await openCrop(file, {
        title: `框出「${info.label}」`,
        aspect: (aw || 1) / (ah || 1),
      });
    } catch (e) {
      return toast(e.message || "这张图读不出来");
    }
    if (!blob) return;

    try {
      const ext = blob.type === "image/jpeg" ? "jpg" : "png";
      await cwApi.upload(new File([blob], `${v}.${ext}`, { type: blob.type || "image/png" }), {
        cardId,
        slot: "extra",
        view: v,
        label: info.label,
        source: "upload",
      });
      await refreshCard();
      toast(`「${info.label}」已换成本次上传的图`);
    } catch (e) {
      toast("上传失败：" + e.message);
    }
  };

  /**
   * 只补这一个角度。
   *
   * 这个入口的意义是「我就要这张侧脸」，不该被逼着勾选 + 开始补一批。
   * 已有 AI 图 → 换个种子重画（同角度只留一张的约定交给后端覆盖）；
   * 没有 → 建一个只含该视图的任务。
   */
  const soloForView = async (v) => {
    const p = curPreset();
    if (!p) return toast("先选一套做法");
    if (!p.available) return toast("这套做法当前缺模型");
    if (st.running) return toast("等当前这一批跑完再补这张");

    const info = viewInfoOf(v);
    const mine = st.extras.filter((e) => e.view === v);
    try {
      if (mine.length && mine[0].source !== "upload") {
        const solo = await cwApi.supplementRerun({
          cardId,
          file: mine[0].file,
          newSeed: true,
        });
        toast(`「${info.label}」已重新排队`);
        watch(solo);
        return;
      }
      st.identity = identInput.value.trim();
      const job = await cwApi.supplementRun({
        cardId,
        presetId: p.id,
        views: [v],
        identity: st.identity,
        extra: st.extra,
        name: card.name || "",
        autoAttach: true,
      });
      watch(job);
    } catch (e) {
      toast(e.message);
    }
  };

  const renderViews = () => {
    const p = curPreset();
    if (!p) {
      viewWrap.style.display = "none";
      return;
    }
    viewBox.replaceChildren();

    if (p.mode === "sheet") {
      viewWrap.style.display = "";
      viewBox.append(
        el("div", {
          class: "cw-hint",
          text: "整表模式：一次出完整设定表，不能拆格重跑（格与格是联合生成的）。" +
                "不满意就整张重跑。",
        })
      );
      viewHint.textContent =
        "整表一次画进一张图，所以这里没有逐格上传 —— 想按角度一张张补齐，换「逐张补图」那套做法。";
      identHint.textContent =
        "默认以卡片底稿为参考图。这里补的是「图里看不清」的部分 —— 写具体一点有帮助，写长了反而会抢镜。";
      return;
    }

    viewWrap.style.display = "";
    if (!st.views.size) (p.views || []).forEach((v) => st.views.add(v));

    for (const v of p.views || []) {
      const on = st.views.has(v);
      const info = viewInfoOf(v);
      const mine = st.extras.filter((e) => e.view === v);
      // 这个角度自己已经有图就显示它；没有就拿卡片底稿当底，
      // 压暗 + 写「未补」—— 用户一眼能分清"这是参考"还是"这是成果"。
      const src = mine.length ? (mine[0].thumb || mine[0].file) : card.main;

      const thumb = el("div", {
        class: "cw-sup-vthumb" + (mine.length ? " is-filled" : ""),
      });
      if (src) {
        thumb.append(
          el("img", {
            src: assetUrl(src, mine.length ? mine[0].createdAt || 0 : 0),
            alt: "",
            draggable: "false",
          })
        );
      } else {
        thumb.append(el("div", { class: "cw-sup-vph", text: info.label }));
      }
      if (!mine.length) {
        thumb.append(el("div", { class: "cw-sup-vnone", text: "未补" }));
      }

      // 左上角勾选：只决定「开始补图」这批跑不跑这一格，不是主操作
      const mark = el("button", {
        class: "cw-sup-vmark" + (on ? " is-on" : ""),
        type: "button",
        text: on ? "✓" : "",
        title: on ? "这一格交给 AI 出图（点一下跳过）" : "这一格跳过（点一下让 AI 出）",
        onclick: (e) => {
          e.stopPropagation();
          toggleView(v);
        },
      });

      // 悬停浮出来的两个入口 —— 用户要的是"就补这张"，而不是先勾选再批量
      const acts = el("div", { class: "cw-sup-vacts" }, [
        el("button", {
          class: "cw-sup-vact is-ai",
          type: "button",
          text: mine.length ? "AI 重补" : "AI 补这张",
          title: mine.length
            ? "换一个种子重画这个角度，替换现有这张"
            : "只跑这一个角度，不影响其它格子",
          onclick: (e) => {
            e.stopPropagation();
            soloForView(v);
          },
        }),
        el("button", {
          class: "cw-sup-vact is-up",
          type: "button",
          text: "手动上传",
          title: "从本机选一张，框选后放进这一格",
          onclick: (e) => {
            e.stopPropagation();
            uploadForView(v);
          },
        }),
      ]);
      thumb.append(mark, acts);

      const badge = mine.length
        ? el("span", {
            class: "cw-sup-vbadge " + (mine[0].source === "upload" ? "is-manual" : "is-ai"),
            text: mine[0].source === "upload" ? "手动" : "AI",
          })
        : null;

      const cap = el("div", { class: "cw-sup-vcap" }, [
        el("div", { class: "cw-sup-vname" }, [el("span", { text: info.label }), badge]),
        el("div", { class: "cw-sup-vguide", text: info.guide }),
      ]);

      const cardEl = el("div", {
        class: "cw-sup-vcard" + (on ? " is-on" : "") + (mine.length ? " is-owned" : ""),
      }, [thumb, cap]);

      // 点卡内空白 = 切换勾选；按钮各自 stopPropagation，不会一次点两下
      cardEl.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        toggleView(v);
      });

      viewBox.append(cardEl);
    }

    viewHint.textContent =
      "鼠标移到任意一格上，会浮出「AI 补这张」和「手动上传」—— " +
      "只补一个角度不用勾选，点它就行。底部的「开始补图」跑的是所有打了 ✓ 的格子。";
    identHint.textContent =
      "每个视图都是「把底稿改成那个角度」，身份由参考图锚定。这里填的是补丁：" +
      "图里看不清的颜色、配饰、纹样 —— 留空也能跑。";
  };

  /* ---------- 已补过的图 ---------- */

  const refreshCard = async () => {
    try {
      const lib2 = await cwApi.getLibrary();
      const c2 = (lib2.cards || []).find((c) => c.id === cardId);
      if (!c2) return;
      st.extras = (c2.extras || []).filter(isSupplementExtra);
      renderOwned();
      renderViews();
    } catch (e) {
      /* 刷不到就保持原样，不影响主流程 */
    }
  };

  const renderOwned = () => {
    ownedBox.replaceChildren();
    ownedWrap.style.display = st.extras.length ? "" : "none";
    if (!st.extras.length) return;

    const list = [...st.extras].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const ex of list) {
      const row = el("div", { class: "cw-sup-item" });

      const pic = el("div", { class: "cw-sup-item-pic" });
      const thumb = ex.thumb || ex.file;
      if (thumb) {
        pic.append(el("img", { src: assetUrl(thumb, ex.createdAt || 0), alt: "" }));
      }

      const meta = el("div", { class: "cw-sup-item-meta" }, [
        el("div", {
          class: "cw-sup-item-name",
          text: ex.view ? viewInfoOf(ex.view).label : (ex.label || "补图"),
        }),
        el("div", {
          class: "cw-sup-item-state",
          text: ex.source === "upload"
            ? "手动上传" + (ex.createdAt ? " · " + new Date(ex.createdAt).toLocaleDateString() : "")
            : (ex.seed ? `AI 出图 · seed ${ex.seed}` : (ex.presetId || "AI 出图")),
        }),
      ]);

      meta.append(
        el("div", { class: "cw-sup-item-acts" }, [
          // 手动传的图没有 seed 可复用，「重跑」对它没意义 —— 给「换图」。
          ex.source === "upload"
            ? el("button", {
                class: "cw-btn-mini",
                text: "换图",
                title: "重新框一张替换这张",
                onclick: (e) => {
                  e.stopPropagation();
                  if (!ex.view) return toast("这张图没记角度，删掉后重新传");
                  uploadForView(ex.view);
                },
              })
            : el("button", {
                class: "cw-btn-mini",
                text: "重跑",
                title: "会用新种子重画这张，替换掉现在这张",
                onclick: async (e) => {
                  e.stopPropagation();
                  if (st.running) return toast("等当前这一批跑完");
                  try {
                    const solo = await cwApi.supplementRerun({ cardId, file: ex.file, newSeed: true });
                    toast("已重新排队");
                    watch(solo);
                  } catch (err) {
                    toast(err.message);
                  }
                },
              }),
          el("button", {
            class: "cw-btn-mini cw-danger",
            text: "删除",
            onclick: async (e) => {
              e.stopPropagation();
              if (!window.confirm("删掉这张补图？卡片本身不受影响。")) return;
              try {
                await cwApi.deleteExtra(cardId, ex.file);
                st.extras = st.extras.filter((x) => x.file !== ex.file);
                renderOwned();
                renderViews();
              } catch (err) {
                toast(err.message);
              }
            },
          }),
        ])
      );

      row.append(pic, meta);
      ownedBox.append(row);
    }
  };

  /* ---------- 结果渲染 ---------- */

  const renderJob = (job) => {
    st.job = job;
    const firstShow = resultWrap.style.display === "none";
    resultWrap.style.display = "";
    resultBox.replaceChildren();
    // 结果第一次出现时滚到可视区，别让人以为没反应
    if (firstShow) {
      setTimeout(() => resultWrap.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
    }

    for (const it of job.items) {
      const thumb = it.thumb || it.file;
      const row = el("div", { class: "cw-sup-item" });

      const pic = el("div", { class: "cw-sup-item-pic" });
      if (thumb) {
        pic.append(el("img", { src: assetUrl(thumb, Date.now()), alt: "" }));
      } else {
        pic.append(el("span", { class: "cw-sup-item-ph", text: it.status === "running" ? "…" : "·" }));
      }

      const meta = el("div", { class: "cw-sup-item-meta" }, [
        el("div", { class: "cw-sup-item-name", text: it.label || it.key }),
        el("div", {
          class: "cw-sup-item-state",
          text:
            it.status === "done" ? `seed ${it.seed}`
            : it.status === "failed" ? (it.error || "失败")
            : it.status === "running" ? (it.stage === "sampling" ? "采样中" : "准备中")
            : it.status === "queued" ? "排队中"
            : "待开始",
        }),
      ]);

      if (it.status === "done" && it.file) {
        meta.append(
          el("button", {
            class: "cw-btn-mini",
            text: "重跑这张",
            onclick: async (e) => {
              e.stopPropagation();
              if (st.running) {
                toast("等当前这一张跑完再重跑");
                return;
              }
              try {
                const solo = await cwApi.supplementRerun({
                  cardId: job.cardId,
                  file: it.file,
                  newSeed: true,
                });
                toast("已重新排队");
                await watch(solo);
              } catch (err) {
                toast(err.message);
              }
            },
          })
        );
      }

      row.append(pic, meta);
      resultBox.append(row);
    }

    const doneN = job.items.filter((i) => i.status === "done").length;
    const total = job.items.length;

    const settle = (msg) => {
      statusLine.textContent = msg;
      startBtn.textContent = "开始补图";
      startBtn.classList.add("cw-primary");
      startBtn.disabled = false;
      st.running = false;
    };

    if (job.status === "done") {
      settle(`全部完成（${doneN}/${total}）`);
      // 结果区在长表单底部，出现时自动带过去，否则用户只看到半截卡片
      if (!st.autoScrolled) {
        st.autoScrolled = true;
        resultWrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    } else if (job.status === "failed") {
      settle("出图失败，看上面的错误");
    } else if (job.status === "partial") {
      settle(`部分完成（${doneN}/${total}），失败的可以单独重跑`);
    } else if (job.status === "cancelled") {
      settle("已取消");
    } else {
      const cur = job.items.find((i) => i.status === "running");
      const stageTxt = cur
        ? (cur.stage === "sampling" ? "采样中" : cur.stage === "submitting" ? "提交中" : "准备中")
        : "";
      statusLine.textContent = cur
        ? `进行中 · ${cur.label} ${stageTxt}（${doneN}/${total}）`
        : `排队中（${doneN}/${total}）`;
    }
  };

  /* ---------- 轮询 ---------- */

  const watch = (job) => {
    stopPolling();
    st.running = true;
    st.autoScrolled = false;
    // 跑起来之后这个按钮变成取消 —— 三分钟的等待不给出口是不合理的
    startBtn.textContent = "取消";
    startBtn.classList.remove("cw-primary");
    startBtn.disabled = false;
    renderJob(job);

    const tick = async () => {
      try {
        const s = await cwApi.supplementJob(job.id);
        renderJob(s);
        if (["done", "failed", "partial", "cancelled"].includes(s.status)) {
          st.running = false;
          startBtn.disabled = false;
          // 新图已经入卡，把「已补过的图」和视图上的 ✓ 同步出来
          await refreshCard();
          return;
        }
      } catch (e) {
        statusLine.textContent = `状态读取失败：${e.message}`;
      }
      pollTimer = setTimeout(tick, 1800);
    };
    pollTimer = setTimeout(tick, 900);
  };

  /* ---------- 提交 ---------- */

  startBtn.addEventListener("click", async () => {
    // 运行中这个按钮是「取消」
    if (st.running) {
      if (!st.job) return;
      startBtn.disabled = true;
      statusLine.textContent = "正在取消…";
      try {
        await cwApi.supplementCancel(st.job.id);
        statusLine.textContent = "已取消";
        startBtn.textContent = "开始补图";
        startBtn.classList.add("cw-primary");
        startBtn.disabled = false;
        st.running = false;
      } catch (e) {
        toast(e.message);
        startBtn.disabled = false;
      }
      return;
    }

    const p = curPreset();
    if (!p) return toast("先选一套做法");
    if (!p.available) return toast("这套做法当前缺模型");

    st.identity = identInput.value.trim();
    st.running = true;
    st.autoScrolled = false;
    startBtn.disabled = true;
    statusLine.textContent = "正在提交…";

    try {
      const job = await cwApi.supplementRun({
        cardId,
        presetId: p.id,
        views: p.mode === "sheet" ? [] : [...st.views],
        identity: st.identity,
        extra: st.extra,
        name: card.name || "",
        autoAttach: true,
      });
      watch(job);
    } catch (e) {
      statusLine.textContent = e.message;
      startBtn.disabled = false;
      st.running = false;
    }
  });

  const close = () => {
    stopPolling();
    if (escHandler === onEsc) {
      document.removeEventListener("keydown", onEsc, true);
      escHandler = null;
    }
    mask.remove();
  };

  // 以前点面板外就关，误触太高 —— 表单长、跑一张要六分钟，
  // 手滑点一下界面就没了。现在只有 ✕ 能关。
  // 任务本来就在服务端跑，关掉面板不影响它，重开会接回来。
  function onEsc(e) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (st.running) {
      toast("正在跑，点「取消」才会停下（关面板不影响任务）");
      return;
    }
    close();
  }

  closeBtn.addEventListener("click", close);
  escHandler = onEsc;
  document.addEventListener("keydown", onEsc, true);

  /* ---------- 首次渲染 ---------- */
  renderPresets();
  renderViews();
  renderOwned();

  // 第一次进来默认勾满所有视图
  const p0 = curPreset();
  if (p0 && p0.mode === "set") {
    st.views = new Set(p0.views || []);
    renderViews();
  }

  // 上次没跑完就关掉了？把界面接回去，别让用户以为没在跑、又点一次
  if (active && Array.isArray(active.items) && active.items.length) {
    toast("接回上次没跑完的任务");
    watch(active);
  }
}
