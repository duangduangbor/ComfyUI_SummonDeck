"""怪兽牌组 —— 节点执行逻辑。

一条规则贯穿到底：**prompt 里 @ 出现的先后顺序，就是参考图的编号顺序**。
没被 @ 的卡不会进图（除非 prompt 里一个 @ 都没有，那就按工作台顺序全送）。
"""

from __future__ import annotations

import json
import re

import numpy as np
import torch

import folder_paths  # noqa: F401  保证在 ComfyUI 环境里导入

try:
    from . import storage
except ImportError:      # 某些加载方式下包上下文会丢
    import storage  # type: ignore

PLACEHOLDER = "\x01{}\x01"
PLACEHOLDER_RE = re.compile(r"\x01(\d+)\x01")

DEFAULT_DESC_TPL = "{ref} 是{name}。外观：{identity}。{variable}。"

# 多角色/多对象同框最容易出的问题：特征互相串。给它一句硬约束比堆形容词管用。
MULTI_HINT = "以上每个编号对应各自的参考图，请分别按对应图像还原，不要互相混用特征。"

DESC_MODES = {"off", "core", "full"}


def _fmt(tpl: str, **kw) -> str:
    """用户手写的模板可能带奇怪的占位符，format 失败就原样返回，不让节点崩。"""
    if not tpl:
        return ""
    try:
        return tpl.format(**kw)
    except Exception:
        return tpl


def _clean_text(value) -> str:
    """压成一行。模型对换行不敏感，但换行会让描述看起来像多个段落。"""
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()


def _tidy(line: str) -> str:
    """清掉占位符为空时留下的空壳：'外观：。' / '。。' / 行尾逗号。"""
    s = re.sub(r"[ \t]+", " ", line or "").strip()
    s = re.sub(r"\s+([。，,；;！？!?])", r"\1", s)
    s = re.sub(r"[^\s。，,；;]{0,8}[：:]\s*。", "", s)      # 「外观：。」整段删掉
    s = re.sub(r"[：:]\s*[。，,；;]", "。", s)
    s = re.sub(r"[。，,；;、]{2,}", "。", s)                # 。。 -> 。
    s = re.sub(r"^[。，,；;、\s]+", "", s)
    s = re.sub(r"[，,；;、\s]+$", "", s)
    return s.strip()


def build_desc_block(used_cards, template, desc_tpl, mode):
    """生成「第几张图是谁、长什么样、哪些能动」的设定块。

    为什么整块放最前面，而不是塞进句子里：
      1. @名字 已经在句中换成了 image 1，句子本身保持自然；
      2. 编辑类模型对开头/结尾的指令响应明显强于句中插入；
      3. 多角色时按编号成段列出，身份不容易串。

    返回 (设定块, 实际生效的 card id 集合)
    """
    mode = (mode or "core").lower()
    if mode not in DESC_MODES:
        mode = "core"
    if mode == "off" or not used_cards:
        return "", set()

    tpl = _clean_text(desc_tpl) or DEFAULT_DESC_TPL
    lines, applied = [], set()

    for n, card in enumerate(used_cards, start=1):
        if card.get("descOn") is False:
            continue

        identity = _clean_text(card.get("identity"))
        variable = _clean_text(card.get("variable"))
        detail = _clean_text(card.get("detail")) if mode == "full" else ""
        if not (identity or variable or detail):
            continue

        line = _fmt(
            tpl,
            ref=_fmt(template or "image {n}", n=n, i=n - 1),
            name=_clean_text(card.get("name")) or f"角色{n}",
            n=n, i=n - 1,
            identity=identity,
            variable=variable,
            detail=detail,
        )
        # 模板里没留 {detail} 位置，就把长文本接在句尾
        if detail and "{detail}" not in tpl:
            line = f"{line} {detail}"

        line = _tidy(line)
        if line:
            lines.append(line)
            applied.add(card.get("id"))

    if not lines:
        return "", set()

    block = "\n".join(lines)
    if len(lines) >= 2:
        block = f"{block}\n{MULTI_HINT}"
    return block, applied



# --------------------------------------------------------------------------
# @ 解析
# --------------------------------------------------------------------------

def resolve_prompt(prompt: str, cards: list[dict], template: str):
    """把 prompt 里的 @卡名 换成模型能看懂的引用标记。

    返回 (新 prompt, 引用顺序的 card 列表, 未匹配到的 @名字列表)
    """
    prompt = prompt or ""
    cards = [c for c in cards if c.get("name")]

    # 名字长的先匹配，避免「阿离」吃掉「阿离的姐姐」
    ordered_by_len = sorted(cards, key=lambda c: len(c["name"]), reverse=True)

    slots: list[dict] = []
    for card in ordered_by_len:
        token = "@" + card["name"]
        if token not in prompt:
            continue
        idx = len(slots)
        slots.append(card)
        prompt = prompt.replace(token, PLACEHOLDER.format(idx))

    # 按占位符在句子中首次出现的位置决定最终编号
    order: list[int] = []
    for m in PLACEHOLDER_RE.finditer(prompt):
        idx = int(m.group(1))
        if idx not in order:
            order.append(idx)

    final_of: dict[int, int] = {slot_idx: n for n, slot_idx in enumerate(order, start=1)}

    def _to_tag(m: re.Match) -> str:
        slot_idx = int(m.group(1))
        n = final_of.get(slot_idx)
        if n is None:                      # 理论上不会发生
            return m.group(0)
        return template.format(n=n, i=n - 1)

    new_prompt = PLACEHOLDER_RE.sub(_to_tag, prompt)
    used_cards = [slots[i] for i in order]

    # 剩下的 @xxx 是台上没有的卡，提示一下但不阻断
    dangling = re.findall(r"@([^\s@,，。、;；:：]+)", new_prompt)

    return new_prompt, used_cards, dangling


# --------------------------------------------------------------------------
# 图片
# --------------------------------------------------------------------------

def _load_array(path):
    from PIL import Image, ImageOps

    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        return np.array(im)


def _limit_pixels(arr: np.ndarray, max_mp: float) -> np.ndarray:
    from PIL import Image

    if not max_mp or max_mp <= 0:
        return arr
    h, w = arr.shape[:2]
    budget = max_mp * 1024 * 1024
    if w * h <= budget:
        return arr
    scale = (budget / (w * h)) ** 0.5
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    return np.array(Image.fromarray(arr).resize((nw, nh), Image.LANCZOS))


def _pad_to(arr: np.ndarray, width: int, height: int, fill=0.5) -> np.ndarray:
    """等比缩放后居中放进统一画布，空隙填中性灰。"""
    from PIL import Image

    h, w = arr.shape[:2]
    if w == width and h == height:
        return arr
    scale = min(width / w, height / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    resized = np.array(Image.fromarray(arr).resize((nw, nh), Image.LANCZOS))
    canvas = np.full((height, width, 3), int(fill * 255), dtype=np.uint8)
    y0, x0 = (height - nh) // 2, (width - nw) // 2
    canvas[y0:y0 + nh, x0:x0 + nw] = resized
    return canvas


def build_image_batch(paths: list, max_mp: float):
    """把若干张参考图拼成一个 IMAGE batch（等比缩放后居中补灰）。"""
    arrays = []
    for p in paths:
        try:
            arrays.append(_limit_pixels(_load_array(p), max_mp))
        except Exception as exc:
            print(f"[怪兽牌组] 读图失败 {p}: {exc}")

    if not arrays:
        return torch.zeros((1, 64, 64, 3), dtype=torch.float32)

    tw = max(a.shape[1] for a in arrays)
    th = max(a.shape[0] for a in arrays)
    framed = [_pad_to(a, tw, th) for a in arrays]

    stacked = np.stack(framed, axis=0).astype(np.float32) / 255.0
    return torch.from_numpy(stacked)


# --------------------------------------------------------------------------
# 节点
# --------------------------------------------------------------------------

class CharacterWorkbench:
    """怪兽牌组 · SummonDeck 的主节点。

    类名保留 CharacterWorkbench：它就是节点类型名，改了两件事会一起坏 ——
    已存工作流找不到节点、前端 cw-workbench.js 的 beforeRegisterNodeDef 匹配不上。
    """

    CATEGORY = "怪兽牌组"
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = ("参考图", "提示词", "引用对照", "张数", "原始提示词")
    OUTPUT_TOOLTIPS = (
        "按 prompt 中 @ 的先后顺序排列的参考图 batch",
        "角色设定块 + 已把 @卡名 替换成引用标记的提示词",
        "第几张图对应哪张卡、带设定送出了几张，核对用",
        "本次实际送出的参考图张数",
        "角色设定块 + 你写的原文。不做 @ 替换、不自动加 image 编号，给 Qwen2.1 参考出图、Character Sheet 这类固定触发句的工作流用",
    )
    DESCRIPTION = "选卡上台，用 @卡名 在提示词里引用参考图。"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 卡片图片随时可能被替换，不允许吃缓存
        return float("nan")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 单行而非多行：新版前端会把多行 STRING 渲染成真实 textarea，
                # 那样即使隐藏也照样占掉 80 多像素。单行才能压到 0 高。
                "payload": ("STRING", {
                    "multiline": False,
                    "default": '{"prompt": ""}',
                    "dynamicPrompts": False,
                }),
            },
        }

    def run(self, payload: str):
        lib = storage.load_library()
        by_id = {c["id"]: c for c in lib["cards"] if c.get("id")}
        settings = lib.get("settings") or {}
        template = settings.get("refTemplate") or "image {n}"
        max_mp = float(settings.get("maxMegapixel") or 1.0)
        send_extras = bool(settings.get("sendExtras"))

        try:
            state = json.loads(payload or "{}")
        except Exception:
            state = {}

        prompt = state.get("prompt") or ""
        # 工作台是全局的，从库里读；payload 里带的话优先（兼容老工作流）
        workbench_ids = state.get("workbench") or lib.get("workbench") or []

        # 以库为准（图可能换过），库里没了的卡退回快照
        cards = []
        for item in workbench_ids:
            cid = item.get("id") if isinstance(item, dict) else item
            card = by_id.get(cid)
            if card:
                cards.append(card)
            elif isinstance(item, dict) and item.get("name"):
                cards.append(item)

        new_prompt, used_cards, dangling = resolve_prompt(prompt, cards, template)

        # prompt 里一个 @ 都没有 —— 全台送上，按上台顺序编号
        if not used_cards and cards:
            used_cards = list(cards)
            renumbered = f"{new_prompt}".strip()
            if renumbered:
                tags = " ".join(template.format(n=i, i=i - 1) for i in range(1, len(cards) + 1))
                new_prompt = f"{tags}. {renumbered}"
            else:
                new_prompt = ", ".join(
                    template.format(n=i, i=i - 1) for i in range(1, len(cards) + 1)
                )

        # 角色设定：告诉模型每张图是谁、长什么样、哪些能动
        desc_block, desc_applied = build_desc_block(
            used_cards,
            template,
            settings.get("descTemplate") or DEFAULT_DESC_TPL,
            settings.get("descMode") or "core",
        )
        if desc_block:
            head = f"{new_prompt}".strip()
            new_prompt = f"{desc_block}\n\n{head}" if head else desc_block

        # 「原始提示词」也要带设定块 —— Qwen2.1 参考出图这类工作流接的是这一路。
        # 它的「原始」指的是不替换 @、不自动补 image 编号，不是「不带任何附加信息」。
        raw_out = prompt
        if desc_block:
            head = f"{prompt}".strip()
            raw_out = f"{desc_block}\n\n{head}" if head else desc_block

        paths, mapping_lines = [], []
        for n, card in enumerate(used_cards, start=1):
            files = [card.get("main")] if card.get("main") else []
            if send_extras:
                files += [e.get("file") for e in (card.get("extras") or []) if e.get("file")]
            resolved = [str(storage.abs_asset(f)) for f in files if storage.abs_asset(f)]
            for p in resolved:
                paths.append(p)
                mapping_lines.append(f"{len(paths)} ← {card.get('name', '?')}")
            if not resolved:
                mapping_lines.append(f"— {card.get('name', '?')} 缺图")

        images = build_image_batch(paths, max_mp)
        count = len(paths)

        mapping = "\n".join(mapping_lines) if mapping_lines else "（没有引用任何卡）"
        if desc_applied:
            mode_label = {"off": "关闭", "core": "身份锚定", "full": "全部设定"}.get(
                (settings.get("descMode") or "core").lower(), "身份锚定"
            )
            mapping += f"\n带设定送出：{len(desc_applied)} 张（{mode_label}）"
        if dangling:
            missing = "、".join(dict.fromkeys(dangling))
            mapping += f"\n\n台上没有这些名字，未替换：{missing}"
            print(f"[怪兽牌组] 未匹配的 @ 引用：{missing}")

        return (images, new_prompt, mapping, count, raw_out)


NODE_CLASS_MAPPINGS = {"CharacterWorkbench": CharacterWorkbench}
# 显示名换了，**节点类型名故意没换** —— 它是已存工作流里的标识，
# 改了会让老工作流里的节点变红，用户得重新接线。
NODE_DISPLAY_NAME_MAPPINGS = {"CharacterWorkbench": "🎴 怪兽牌组 · SummonDeck"}
