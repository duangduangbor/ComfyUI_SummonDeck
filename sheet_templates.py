"""怪兽牌组 —— 整表（sheet）模式的提示词模板。

`sheet` 模式是「一次前向出一整张多视图设定表」。这种方式的一致性最好，
因为 QuadView / DynamicCharacterSheet 这类 LoRA 在训练时就把多视图关系
学进去了；但也因此**格与格无法拆开重跑**——只能整张重出。

这里只负责把卡里的身份描述注入到固定格式里。
真正的工作流节点在 ``presets.py``。
"""

from __future__ import annotations

import re

# --------------------------------------------------------------------------
# flux2 · QuadView / TripleView
# --------------------------------------------------------------------------
# 触发句必须原样保留（LoRA 认的是这句），身份与可变项追加在后面。
# 实测：写清服装能明显减少各视角之间的漂移（不写时背面容易把裙子画成短裤）。

FLUX2_QUAD = (
    "Convert the character in the image to a Character Sheet showing a face close-up, "
    "front, side and back full body views. Keep the same face, hairstyle, outfit and "
    "body proportions in every view. Plain white background, even studio lighting, "
    "full body visible head to toe, standing straight."
)

FLUX2_TRIPLE = (
    "Convert the character in the image to a Character Sheet showing front, side and "
    "back full body views. Keep the same face, hairstyle, outfit and body proportions "
    "in every view. Plain white background, even studio lighting, full body visible "
    "head to toe, standing straight."
)

FLUX2_NEG = (
    "bad quality, noise, blurry, worst quality, low resolution, blur, distortion, "
    "unnatural blending"
)

# --------------------------------------------------------------------------
# krea2 · DynamicCharacterSheet
# --------------------------------------------------------------------------
# 整段是固定格式，只改 IDENTITY LOCKS 里的条目和 ENTITY_ID。
# 其余一字不动 —— 这是 LoRA 训练时的结构，改了布局就会崩。

KREA2_TEMPLATE = """[TASK: ENTITY_SHEET_GENERATION]
[TEMPLATE: MULTI_ANGLE_ENTITY_SHEET_V1]
[ENTITY_TYPE: HUMAN]
[ENTITY_ID: {entity_id}]

Convert the subject in Image 1 into one standardized advanced Character Sheet. Image 1 is the sole identity and design reference. Preserve the exact same design, proportions, colors, materials, and every signature detail. Do not redesign, beautify, or simplify it.

FIXED LANDSCAPE SHEET FORMAT
Use a clean 3:2 landscape canvas with a warm off-white paper background and generous white space. Organize one coherent sheet with these fixed zones:
1. LEFT METADATA COLUMN: the exact name, ENTITY TYPE, CORE MOOD, and VISUAL SIGNATURE in compact readable English.
2. LARGE CENTER HERO VIEW: one dominant full-body three-quarter view.
3. TOP-RIGHT TURNAROUND ROW: neutral FRONT FULL BODY, SIDE FULL BODY, and BACK FULL BODY views at matching scale, with all extremities visible.
4. MID-RIGHT ACTION POSES: three readable views including a low angle, an overhead or high angle, and one characteristic action.
5. BOTTOM-LEFT SILHOUETTE STUDY: three solid black silhouettes that preserve the design shape.
6. BOTTOM-CENTER EXPRESSION STUDY: one clear neutral face close-up plus three compact expression studies showing meaningful variation without changing identity.
7. BOTTOM-RIGHT DETAIL STUDY: six close-up crops of the most identity-critical features, materials, face, and accessories.

IDENTITY LOCKS
{identity_lines}
- Keep the subject from Image 1 recognizable in every view.
- Keep handedness, asymmetry, costume, and color placement consistent.

VISIBLE TEXT
All labels must be English only. Keep labels short and legible. Do not invent lore paragraphs.

NEGATIVE CONSTRAINTS
No extra character or object, identity drift, wardrobe drift, material drift, inconsistent markings, changed proportions, missing extremities, duplicated limbs, merged views, overlapping panels, logo, watermark, or unrelated decoration."""

KREA2_NEG = ""   # krea2 的负向留空（cfg 1.0，负向无效）

# --------------------------------------------------------------------------
# 身份描述 → 英文条目
# --------------------------------------------------------------------------
# 卡里的 identity 是中文短标签，但这两个 LoRA 的文本编码器对英文更敏感，
# 尤其 flux2 用的是 qwen_3_8b（多语言尚可），krea2 是 qwen3vl_4b。
# 保留原文不翻译——翻译会引入我不该编造的信息。中文它也能吃，
# 而且用户写什么就是什么，比机器瞎翻安全。

_SPLIT = re.compile(r"[,，、;；\n]+")


def identity_lines(text: str, bullet: str = "- ") -> str:
    """把一段身份描述拆成条目行。"""
    if not text or not text.strip():
        return (bullet + "Match the subject in Image 1 exactly: same face, same hairstyle, "
                "same outfit, same colors.")
    parts = [p.strip().rstrip(".。") for p in _SPLIT.split(text) if p.strip()]
    if not parts:
        return bullet + text.strip()
    return "\n".join(bullet + p for p in parts)


def _slug(name: str) -> str:
    """ENTITY_ID 只留安全字符。"""
    s = re.sub(r"[^0-9A-Za-z_]+", "_", (name or "").strip()).strip("_").lower()
    return s or "character"


# --------------------------------------------------------------------------
# 对外
# --------------------------------------------------------------------------

def build_sheet_prompt(preset_id: str, *, identity: str = "", extra: str = "",
                       name: str = "", variant: str = "") -> str:
    """生成整表模式的完整提示词。"""
    ident = (identity or "").strip()
    tail = (extra or "").strip()

    if preset_id == "flux2_sheet":
        base = FLUX2_TRIPLE if variant == "triple" else FLUX2_QUAD
        if ident:
            base += f" Appearance: {ident.rstrip('.,')}."
        if tail:
            base += f" {tail.rstrip('.,')}."
        return base

    if preset_id == "krea_sheet":
        return KREA2_TEMPLATE.format(
            entity_id=_slug(name),
            identity_lines=identity_lines(ident),
        )

    # 兜底：拿 identity + extra 拼一句
    return ", ".join(x for x in (ident, tail) if x) or "character reference sheet"


def sheet_negative(preset_id: str) -> str:
    if preset_id == "flux2_sheet":
        return FLUX2_NEG
    if preset_id == "krea_sheet":
        return KREA2_NEG
    return ""
