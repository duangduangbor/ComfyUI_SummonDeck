"""怪兽牌组 —— 预设工作流存储。

两层文件
--------
    presets_ui/<id>.json                     内置基线（插件目录，发布时带出去）
    user/default/character_workbench/presets/<id>.json   用户改过的覆写

「重置」就是删掉覆写那份 —— 基线永远不动，所以永远有退路。

基线文件第一次用到时如果不存在，会从 ``presets.py`` 里的 API 模板
自动生成一份可编辑的 UI 画布（自动布局）。这样加新预设时不用手写
一份几百行的画布 JSON。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

try:
    from . import presets as P
    from . import storage
    from . import workflow_io as W
except ImportError:
    import presets as P  # type: ignore
    import storage  # type: ignore
    import workflow_io as W  # type: ignore

BASE_DIR = Path(__file__).resolve().parent / "presets_ui"


# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------

def override_dir() -> Path:
    d = storage.ROOT / "presets"
    d.mkdir(parents=True, exist_ok=True)
    return d


def baseline_path(preset_id: str) -> Path:
    return BASE_DIR / f"{preset_id}.json"


def override_path(preset_id: str) -> Path:
    return override_dir() / f"{preset_id}.json"


def has_override(preset_id: str) -> bool:
    return override_path(preset_id).is_file()


# --------------------------------------------------------------------------
# 读写
# --------------------------------------------------------------------------

def _read(path: Path) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("nodes"), list):
            return data
    except Exception:
        return None
    return None


GEN_VERSION = 2


def _usable(ui: dict) -> bool:
    """这份画布还能不能用来跑。

    光看"能不能解析"不够 —— 生成器早期版本在 object_info 不全时，
    会写出 nodes 全空、widgets_values 全空的文件，JSON 合法但一跑就报
    「Required input is missing」。所以按结构判一次，坏了就重新生成。
    """
    if not ui or not isinstance(ui.get("nodes"), list) or not ui["nodes"]:
        return False
    if (ui.get("extra") or {}).get("cwGen") != GEN_VERSION:
        return False
    for node in ui["nodes"]:
        if node.get("type") in ("MarkdownNote", "Note"):
            continue
        # 除了纯 UI 节点，任何节点都应当至少有一个 widget 值或一个输入槽
        if not (node.get("widgets_values") or node.get("inputs")):
            return False
    return True


def _write_atomic(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def ensure_baseline(preset_id: str) -> dict:
    """基线不存在（或已损坏）时从 API 模板生成一份可编辑画布。"""
    preset = P.get_preset(preset_id)
    if not preset:
        raise ValueError(f"未知预设：{preset_id}")

    existing = _read(baseline_path(preset_id))
    if existing and _usable(existing):
        return existing

    api = preset.get("workflow") or {}
    try:
        ui = W.api_to_ui(api, title=preset_id)
    except RuntimeError as e:
        # 转成 ValueError，让上层统一按「用户能看懂的失败」处理
        raise ValueError(str(e))
    if not ui.get("nodes"):
        raise ValueError(
            "拿不到节点定义，无法生成可编辑画布。"
            "（ComfyUI 的 object_info 此刻不可用，稍后再试）"
        )
    ui["extra"] = ui.get("extra") or {}
    ui["extra"]["cwPresetId"] = preset_id
    ui["extra"]["cwGen"] = GEN_VERSION
    try:
        _write_atomic(baseline_path(preset_id), ui)
    except Exception:
        # 插件目录只读时也能跑，只是重置后要重新生成
        pass
    return ui


def get_ui(preset_id: str) -> dict:
    """当前生效的画布。用户改过就用改过的。"""
    if not P.get_preset(preset_id):
        raise ValueError(f"未知预设：{preset_id}")
    override = _read(override_path(preset_id))
    if override:
        return override
    return ensure_baseline(preset_id)


def save_ui(preset_id: str, ui: dict) -> dict:
    """存用户改动。落盘前先验一遍能不能转成 API ——

    存进去一份跑不起来的画布，比不让存更糟：用户要等到补图失败才发现。
    """
    if not P.get_preset(preset_id):
        raise ValueError(f"未知预设：{preset_id}")
    if not isinstance(ui, dict) or not isinstance(ui.get("nodes"), list):
        raise ValueError("不是有效的工作流画布")

    api, issues = W.ui_to_api(ui)
    if not api:
        raise ValueError("画布是空的，没有可执行的节点")

    types = {n["class_type"] for n in api.values()}
    if "SaveImage" not in types and "PreviewImage" not in types:
        raise ValueError("画布缺少 SaveImage 节点，出图拿不到结果")

    if issues:
        raise ValueError("画布有问题：" + "；".join(issues[:3]))

    _write_atomic(override_path(preset_id), ui)
    return ui


def reset(preset_id: str) -> dict:
    """删掉覆写，回到内置基线。"""
    if not P.get_preset(preset_id):
        raise ValueError(f"未知预设：{preset_id}")
    p = override_path(preset_id)
    if p.is_file():
        try:
            p.unlink()
        except Exception as e:
            raise ValueError(f"删不掉覆写文件：{e}")
    # 基线上如果被手改坏了，重置时顺手重新生成
    if not _read(baseline_path(preset_id)):
        try:
            baseline_path(preset_id).unlink(missing_ok=True)
        except Exception:
            pass
    return ensure_baseline(preset_id)


def meta(preset_id: str) -> dict:
    """给界面用的一句话状态。"""
    preset = P.get_preset(preset_id)
    if not preset:
        return {"id": preset_id, "exists": False}
    ui = get_ui(preset_id)
    api, issues = W.ui_to_api(ui)
    return {
        "id": preset_id,
        "exists": True,
        "edited": has_override(preset_id),
        "nodes": len(ui.get("nodes") or []),
        "executable": len(api),
        "issues": issues[:5],
    }
