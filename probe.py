"""怪兽牌组 —— 模型探测。

把 ComfyUI 当前的模型清单，翻译成「哪些补图预设可用、缺什么」。

探测结果带 TTL 缓存：模型列表变化不频繁，而 safetensors 头解析要读文件，
每次开面板都扫一遍会卡。
"""

from __future__ import annotations

import fnmatch
import os
import threading
import time
from pathlib import Path

try:
    from . import presets as P
except ImportError:
    import presets as P  # type: ignore


# --------------------------------------------------------------------------
# 模型清单
# --------------------------------------------------------------------------

# ComfyUI 不同版本目录名不一样，按顺序找第一个有内容的
_DIR_KEYS = {
    "ckpt":  ["checkpoints"],
    "unet":  ["diffusion_models", "unet"],
    "clip":  ["text_encoders", "clip"],
    "vae":   ["vae"],
    "lora":  ["loras", "lora"],
    "clip_vision": ["clip_vision"],
    "controlnet": ["controlnet", "t2i_adapter"],
    "ipadapter": ["ipadapter"],
}

_cache: dict = {"at": 0.0, "data": None}
_cache_lock = threading.Lock()
CACHE_TTL = 20.0   # 秒


def _raw_list(kind: str) -> list[str]:
    """取某类模型的相对文件名列表。

    ``kind`` 用短名（ckpt / unet / lora ...），内部按 ``_DIR_KEYS``
    的候选目录名逐个试。以前直接拿短名当 folder_paths 的键用，
    结果 ``lora`` 对不上 ``loras``，LoRA 池永远是空的。
    """
    try:
        import folder_paths  # type: ignore
    except Exception:
        return []

    for key in _DIR_KEYS.get(kind, [kind, kind + "s"]):
        try:
            got = folder_paths.get_filename_list(key)
        except Exception:
            continue
        if got:
            return list(got)
    return []


def _full_path(kind: str, name: str) -> str:
    """把相对文件名解析成绝对路径（给 safetensors 头解析用）。"""
    try:
        import folder_paths  # type: ignore
    except Exception:
        return ""
    for key in _DIR_KEYS.get(kind, [kind, kind + "s"]):
        try:
            p = folder_paths.get_full_path(key, name)
            if p:
                return p
        except Exception:
            continue
    return ""


def _match(names: list[str], patterns: list[str]) -> list[str]:
    """按 patterns 的顺序做优先级匹配。

    越靠前的 pattern 越优先 —— 这样预设能把"原工作流验证过的那套文件"
    写在前面，避免探测出同族但不一定兼容的替代品。
    """
    out, seen = [], set()
    for pat in patterns:
        low_pat = pat.lower()
        for n in names:
            if n in seen:
                continue
            if fnmatch.fnmatch(n.lower(), low_pat):
                out.append(n)
                seen.add(n)
    return out


def _sniff_with_cache(kind: str, names: list[str], limit: int = 12) -> dict[str, str]:
    """对少量文件做架构嗅探，结果按 (kind, name) 记忆。"""
    global _sniff_memo
    out = {}
    for n in names[:limit]:
        key = (kind, n)
        if key in _sniff_memo:
            out[n] = _sniff_memo[key]
            continue
        fam = P.sniff_family({"path": _full_path(kind, n)})
        if not fam:
            fam = P.guess_family(n)
        _sniff_memo[key] = fam
        out[n] = fam
    return out


_sniff_memo: dict = {}


# --------------------------------------------------------------------------
# 预设可用性
# --------------------------------------------------------------------------

def _pick(kind: str, families: list[str], names: list[str]) -> list[str]:
    """按架构族挑出候选文件名。"""
    if not families:
        return list(names)
    fam_map = _sniff_with_cache(kind, names)
    out = []
    for n in names:
        fam = fam_map.get(n) or P.guess_family(n)
        if fam in families:
            out.append(n)
    return out


def probe() -> dict:
    """返回完整探测结果。

    {
      "models": {ckpt:[...], unet:[...], clip:[...], vae:[...], lora:[...]},
      "families": {ckpt:{name:family}, ...},
      "presets": [ {id,label,mode,available,missing,defaults,loras,hint} ],
      "consistency": {"ipadapter": bool, "clip_vision": bool, "controlnet": bool},
      "at": ts
    }
    """
    with _cache_lock:
        if _cache["data"] and (time.time() - _cache["at"]) < CACHE_TTL:
            return _cache["data"]

    raw = {k: _raw_list(k) for k in _DIR_KEYS}

    # 架构族映射（给前端显示"这是什么架构"用）
    families = {}
    for kind in ("ckpt", "unet"):
        names = raw.get(kind) or []
        fam_map = _sniff_with_cache(kind, names, limit=40)
        # 没嗅出来的用文件名兜底
        for n in names:
            if not fam_map.get(n):
                fam_map[n] = P.guess_family(n)
        families[kind] = fam_map

    # 一致性工具是否具备（SDXL 逐张出图能不能锚住脸，全看这些）
    consistency = {
        "ipadapter": bool(_raw_list("ipadapter")),
        "clip_vision": bool(_raw_list("clip_vision")),
        "controlnet": bool(_raw_list("controlnet")),
    }

    out_presets = []
    for preset in P.PRESETS:
        need = preset.get("need") or {}
        picked = {}
        missing = []

        # 必需项：ckpt 或 unet，外加配套的 clip / vae
        # need 的值可以是纯 list（= 架构族），也可以是 dict（族 + 文件名特征）
        for kind, spec in need.items():
            if isinstance(spec, dict):
                fams = spec.get("families") or []
                pats = spec.get("patterns") or []
            else:
                fams = spec or []
                pats = []

            pool = raw.get(kind) or []
            if fams:
                cands = _pick(kind, fams, pool)
            else:
                cands = list(pool)
            if pats:
                # 只在已有候选里收窄；候选为空时对全池匹配，让报错更有意义
                cands = _match(cands or pool, pats)

            if cands:
                picked[kind] = cands
            else:
                label = {"ckpt": "checkpoint", "unet": "diffusion model",
                         "clip": "文本编码器", "vae": "VAE",
                         "lora": "LoRA"}.get(kind, kind)
                fam_txt = " / ".join(fams) if fams else ("文件名匹配 " + " ".join(pats) if pats else "任意")
                missing.append(f"缺 {label}（{fam_txt}）")

        # 可选 LoRA
        opt = preset.get("opt") or {}
        loras = []
        if "lora" in opt:
            loras = _match(raw.get("lora") or [], opt["lora"])

        available = not missing
        defaults = {}
        for kind, cands in picked.items():
            defaults[kind] = cands[0]
        # 可选 LoRA 不设默认值 —— 只有用户显式选了才挂。
        # 自动挂错的概率比自动挂对的收益大得多。

        fam = preset.get("family", "")

        # 现在只留参考图驱动的模型，一致性由参考图本身保证，
        # 不再需要 IPAdapter 那套降级标记。留着字段是为了前端不用改。
        weak = False

        out_presets.append({
            "id": preset["id"],
            "label": preset["label"],
            "family": fam,
            "mode": preset.get("mode", "set"),
            "needsImage": bool(preset.get("needsImage", True)),
            "hint": preset.get("hint", ""),
            "available": available,
            "missing": missing,
            "weakConsistency": weak,
            "candidates": picked,
            "defaults": defaults,
            "loras": loras,
            "variants": preset.get("variants") or [],
            "views": preset.get("views") or list(P.DEFAULT_SET_VIEWS),
            "steps": preset.get("steps"),
            "cfg": preset.get("cfg"),
            "fixedSize": (preset.get("size") or {}).get("fixed"),
        })

    data = {
        "models": raw,
        "families": families,
        "presets": out_presets,
        "consistency": consistency,
        "at": int(time.time()),
    }
    with _cache_lock:
        _cache["at"] = time.time()
        _cache["data"] = data
    return data


def _model_root() -> Path:
    try:
        import folder_paths  # type: ignore
        return Path(folder_paths.models_dir)
    except Exception:
        return Path(__file__).resolve().parents[2] / "models"


def invalidate() -> None:
    """模型装好之后想让界面立刻刷新时调用。"""
    with _cache_lock:
        _cache["at"] = 0.0
        _cache["data"] = None
    _sniff_memo.clear()


def resolve_models(preset_id: str, overrides: dict | None = None) -> dict:
    """把前端选定的（或默认的）模型名整理成渲染参数。"""
    data = probe()
    entry = next((p for p in data["presets"] if p["id"] == preset_id), None)
    if not entry:
        raise ValueError(f"未知预设：{preset_id}")

    models = dict(entry.get("defaults") or {})
    for k, v in (overrides or {}).items():
        if v:
            models[k] = v

    # SDXL 族若没指定 VAE，走 checkpoint 内置的（模板里用 ["1",2]）
    if not models.get("vae") and entry["family"] not in ("sdxl", "sd15"):
        vaes = _raw_list("vae")
        if vaes:
            models["vae"] = vaes[0]
    return models
