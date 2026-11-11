/**
 * 怪兽牌组 —— 底稿裁切器
 *
 * 为什么要裁：
 *   很多人的素材是一整张图（设定表、多视图拼图、带白边的商品图）。
 *   让系统自动判断"哪一块是脸"很难，让用户拖一下很简单。
 *   微信头像那种交互：**框固定、图能动**，缩放和平移都由用户控制。
 *
 * 实现用一张 canvas 画完：图 + 遮罩 + 边框。
 * 不用 DOM transform，是因为取源图坐标时要反算，canvas 一条公式就够，
 * DOM 叠 CSS 变换得反算两次，容易错位。
 */

import { el, isDarkTheme } from "./cw-core.js";

const ASPECTS = [
  { id: "1:1", label: "1:1", value: 1 },
  { id: "3:4", label: "3:4", value: 3 / 4 },
  { id: "2:3", label: "2:3", value: 2 / 3 },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "16:9", label: "16:9", value: 16 / 9 },
  { id: "orig", label: "原图比例", value: 0 },
];

const STAGE_W = 620;
const STAGE_H = 460;

/** 把 File/Blob 解成可绘制的位图，顺带把 EXIF 方向摆正。 */
async function toBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      /* 老浏览器不支持参数，走下面的兜底 */
    }
    try {
      return await createImageBitmap(file);
    } catch (e) {
      /* 继续兜底 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("这张图读不出来"));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function openCrop(file, { title = "裁切底稿", aspect = 3 / 4 } = {}) {
  const bitmap = await toBitmap(file);
  const imgW = bitmap.width;
  const imgH = bitmap.height;

  return new Promise((resolve) => {
    let ratio = aspect || imgW / imgH;
    if (ratio === 0) ratio = imgW / imgH;

    /* ---- 画布 ---- */
    const canvas = el("canvas", { class: "cw-crop-canvas", width: STAGE_W, height: STAGE_H });
    const ctx = canvas.getContext("2d");

    /* ---- 裁切框尺寸（随比例变化，始终塞进舞台） ---- */
    let cropW = 0;
    let cropH = 0;
    let cropX = 0;
    let cropY = 0;

    const layoutCrop = () => {
      const pad = 26;
      const maxW = STAGE_W - pad * 2;
      const maxH = STAGE_H - pad * 2;
      if (maxW / maxH > ratio) {
        cropH = maxH;
        cropW = cropH * ratio;
      } else {
        cropW = maxW;
        cropH = cropW / ratio;
      }
      cropX = (STAGE_W - cropW) / 2;
      cropY = (STAGE_H - cropH) / 2;
    };

    /* ---- 视图变换：scale + offset ---- */
    let zoom = 1;
    let scale = 1;
    let ox = 0;
    let oy = 0;

    const baseScale = () => Math.max(cropW / imgW, cropH / imgH);

    const clampOffset = () => {
      const w = imgW * scale;
      const h = imgH * scale;
      // 图必须始终盖满裁切框，不允许露出背景
      ox = Math.min(cropX, Math.max(cropX + cropW - w, ox));
      oy = Math.min(cropY, Math.max(cropY + cropH - h, oy));
    };

    const resetView = () => {
      scale = baseScale();
      ox = cropX + (cropW - imgW * scale) / 2;
      oy = cropY + (cropH - imgH * scale) / 2;
      clampOffset();
      draw();
    };

    const draw = () => {
      ctx.clearRect(0, 0, STAGE_W, STAGE_H);

      // 舞台底色
      ctx.fillStyle = isDarkTheme() ? "#141517" : "#ececee";
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);

      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, ox, oy, imgW * scale, imgH * scale);

      // 框外压暗（四条边，不用合成模式，兼容性最稳）
      ctx.fillStyle = "rgba(10,10,12,0.58)";
      ctx.fillRect(0, 0, STAGE_W, cropY);
      ctx.fillRect(0, cropY + cropH, STAGE_W, STAGE_H - cropY - cropH);
      ctx.fillRect(0, cropY, cropX, cropH);
      ctx.fillRect(cropX + cropW, cropY, STAGE_W - cropX - cropW, cropH);

      // 框线 + 三分线
      ctx.strokeStyle = "rgba(255,255,255,0.92)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cropX + 0.75, cropY + 0.75, cropW - 1.5, cropH - 1.5);

      ctx.strokeStyle = "rgba(255,255,255,0.26)";
      ctx.lineWidth = 1;
      for (let i = 1; i <= 2; i += 1) {
        const x = cropX + (cropW * i) / 3;
        const y = cropY + (cropH * i) / 3;
        ctx.beginPath();
        ctx.moveTo(x, cropY);
        ctx.lineTo(x, cropY + cropH);
        ctx.moveTo(cropX, y);
        ctx.lineTo(cropX + cropW, y);
        ctx.stroke();
      }

      // 四角加粗，模仿微信那圈角标
      ctx.strokeStyle = "rgba(255,255,255,0.98)";
      ctx.lineWidth = 3;
      const L = Math.min(22, cropW / 4, cropH / 4);
      const corners = [
        [cropX, cropY, 1, 1],
        [cropX + cropW, cropY, -1, 1],
        [cropX, cropY + cropH, 1, -1],
        [cropX + cropW, cropY + cropH, -1, -1],
      ];
      for (const [cx, cy, dx, dy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx + dx * L, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + dy * L);
        ctx.stroke();
      }
    };

    /* ---- 交互：拖动平移，滚轮缩放 ---- */
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("is-dragging");
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      ox += e.clientX - lastX;
      oy += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      clampOffset();
      draw();
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      canvas.classList.remove("is-dragging");
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        // 以光标为锚点缩放，手感比以中心缩放自然得多
        const mx = e.offsetX;
        const my = e.offsetY;
        const next = Math.min(baseScale() * 10, Math.max(baseScale(), scale * factor));
        if (next === scale) return;
        const k = next / scale;
        ox = mx - (mx - ox) * k;
        oy = my - (my - oy) * k;
        scale = next;
        clampOffset();
        draw();
      },
      { passive: false }
    );

    /* ---- 比例切换 ---- */
    const aspectRow = el("div", { class: "cw-crop-aspects" });
    const aspectBtns = ASPECTS.map((a) => {
      const btn = el("button", {
        class: "cw-crop-aspect",
        type: "button",
        text: a.label,
        onclick: () => {
          for (const b of aspectBtns) b.classList.remove("is-on");
          btn.classList.add("is-on");
          ratio = a.value || imgW / imgH;
          layoutCrop();
          resetView();
        },
      });
      aspectRow.append(btn);
      return btn;
    });

    /* ---- 底部 ---- */
    const hint = el("div", {
      class: "cw-crop-hint",
      text: "拖动图片调整位置 · 滚轮缩放 · 框外部分会被裁掉",
    });

    const cancelBtn = el("button", { class: "cw-btn-ghost", type: "button", text: "取消" });
    const okBtn = el("button", {
      class: "cw-btn-lg",
      type: "button",
      text: "用这块",
      style: "max-width:150px",
    });

    const panel = el("div", { class: "cw-crop-panel" }, [
      el("div", { class: "cw-crop-head" }, [
        el("div", {}, [el("b", { text: title })]),
      ]),
      el("div", { class: "cw-crop-stage" }, [canvas]),
      el("div", { class: "cw-crop-bar" }, [aspectRow, hint]),
      el("div", { class: "cw-crop-foot" }, [cancelBtn, okBtn]),
    ]);

    const mask = el("div", { class: "cw-crop-mask" }, [panel]);
    if (isDarkTheme()) mask.classList.add("cw-dark");

    const close = (result) => {
      document.removeEventListener("keydown", onKey, true);
      mask.remove();
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        okBtn.click();
      }
    };
    document.addEventListener("keydown", onKey, true);

    cancelBtn.addEventListener("click", () => close(null));

    okBtn.addEventListener("click", async () => {
      // 反算源图坐标：裁切框在画布上是 cropX/cropW，图在画布上是 ox/imgW*scale
      const sx = (cropX - ox) / scale;
      const sy = (cropY - oy) / scale;
      const sw = cropW / scale;
      const sh = cropH / scale;

      // 输出限长边 1536：参考图再大对模型没帮助，只会拖慢上传和预缩放
      const maxSide = 1536;
      const k = Math.min(1, maxSide / Math.max(sw, sh));
      const outW = Math.max(64, Math.round(sw * k));
      const outH = Math.max(64, Math.round(sh * k));

      const out = document.createElement("canvas");
      out.width = outW;
      out.height = outH;
      const octx = out.getContext("2d");
      octx.imageSmoothingQuality = "high";
      octx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);

      const blob = await new Promise((res) => out.toBlob(res, "image/png"));
      close(blob);
    });

    document.body.append(mask);
    layoutCrop();
    resetView();
    // 按钮选中态必须跟真正用的比例一致。
    // 以前这里写死了点亮 3:4，结果传 1:1 进来时框是方的、按钮却亮着 3:4 ——
    // 用户以为没生效，回头又手动点一次，反而把比例改掉了。
    // 另外传 0（原图比例）进来时，得点亮最后一个「原图比例」，
    // 否则一排按钮全灭，用户不知道当前到底按什么框的。
    for (const b of aspectBtns) b.classList.remove("is-on");
    if (!aspect) {
      const origIdx = ASPECTS.findIndex((a) => a.id === "orig");
      aspectBtns[origIdx].classList.add("is-on");
    } else {
      const hitIdx = ASPECTS.findIndex((a) => a.value && Math.abs(ratio - a.value) < 0.01);
      if (hitIdx >= 0) aspectBtns[hitIdx].classList.add("is-on");
    }
  });
}
