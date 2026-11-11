"""怪兽牌组 —— 工作流格式互转。

为什么要自己写这一层
--------------------
预设要同时做两件事：

1. **能在画布上编辑** —— 用户改节点、换 LoRA、调步数，存回去。
   画布只认 UI 格式（nodes / links / widgets_values）。

2. **能直接提交执行** —— ``/prompt`` 只吃 API 格式
   （node_id -> {class_type, inputs}）。

所以两边都得会转。前端那套转换逻辑有两个坑，手写工作流必踩：

1) ``control_after_generate``：KSampler / RandomNoise 的 seed 后面，
   UI 会多存一个 ``"fixed"`` / ``"randomize"``。它**不在** object_info 里，
   按 object_info 顺序取 widgets_values 会从这一步起整段错位一格。

2) Autogrow 动态输入（``COMFY_AUTOGROW_V3``）：UI 里叫 ``image_1``，
   API 里必须写成点号路径 ``images.image_1``。写成扁平的会报
   ``TypeError: unexpected keyword argument 'image_1'``。

这两条都是实测出来的，别"优化"掉。
"""

from __future__ import annotations

import json
import time
import urllib.request

try:
    from . import presets as _P
except ImportError:
    import presets as _P  # type: ignore

# 只当 widget 用的标量类型；其余一律视为连线输入
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
SEED_NAMES = {"seed", "noise_seed"}

# 前端专用的纯 UI 节点：不参与执行，也不在 object_info 里
UI_ONLY_NODES = {"MarkdownNote", "Note", "Reroute", "PreviewAny", "PreviewImage"}

_obj = {"at": 0.0, "data": None}
TTL = 60.0


# --------------------------------------------------------------------------
# object_info
# --------------------------------------------------------------------------
# ⚠️ 这里**不能**用 HTTP 自请求（GET /object_info）。
# 转换代码是在 aiohttp 的 async 处理函数里跑的，同步 urllib 会把事件循环
# 卡住，而那条自请求正好需要这个循环来响应 —— 直接死锁，直到超时。
# 所以改成直接读 nodes.NODE_CLASS_MAPPINGS 在本地拼。

def _node_info_from_class(cls) -> dict | None:
    """照 ComfyUI server.py 的 node_info() 拼一份够用的定义。

    我们只关心 input / output / output_name 三样，其余字段转格式用不到。
    """
    # v3 节点自带现成的 info
    getter = getattr(cls, "GET_NODE_INFO_V1", None)
    if callable(getter):
        try:
            info = getter()
            if isinstance(info, dict) and isinstance(info.get("input"), dict):
                info.setdefault("output", [])
                info.setdefault("output_name", info["output"])
                return info
        except Exception:
            pass

    try:
        inputs = cls.INPUT_TYPES()
    except Exception:
        return None
    if not isinstance(inputs, dict):
        return None

    out_types = list(getattr(cls, "RETURN_TYPES", []) or [])
    out_names = list(getattr(cls, "RETURN_NAMES", out_types) or out_types)
    return {"input": inputs, "output": out_types, "output_name": out_names}


def object_info(force: bool = False) -> dict:
    """取节点定义。带 TTL 缓存 —— 一次上千个节点，不能每次转换都重算。"""
    if not force and _obj["data"] and (time.time() - _obj["at"]) < TTL:
        return _obj["data"]

    out: dict[str, dict] = {}
    try:
        import nodes  # type: ignore
        for name, cls in nodes.NODE_CLASS_MAPPINGS.items():
            info = _node_info_from_class(cls)
            if info:
                out[name] = info
    except Exception:
        out = {}

    # 本地只拼出零星几个，说明这个进程里 nodes 还没初始化完 ——
    # 这种残缺的表比没有更危险（widget 会静默错位），直接当作失败。
    if len(out) < 50:
        out = {}
        # 兜底：本地拿不到才走 HTTP（同步阻塞，不要在 async 上下文里调）
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            from server import PromptServer  # type: ignore
            port = getattr(PromptServer.instance, "port", 8188) or 8188
        except Exception:
            port = 8188
        try:
            with op.open(f"http://127.0.0.1:{port}/object_info", timeout=30) as r:
                out = json.loads(r.read())
        except Exception:
            return _obj["data"] or {}

    _obj["at"] = time.time()
    _obj["data"] = out
    return out


def invalidate() -> None:
    _obj["at"] = 0.0
    _obj["data"] = None


def _server_port() -> int:
    try:
        from server import PromptServer  # type: ignore
        return getattr(PromptServer.instance, "port", 8188) or 8188
    except Exception:
        return 8188


def _fetch_type_http(type_name: str) -> dict:
    """单取一个节点类型。本地表里没有时用它兜底。

    只取一个类型，几十 KB，比整表几 MB 划算得多。
    ⚠️ 同步阻塞，只能在普通线程里调（调用方都已经包在 asyncio.to_thread 里了）。
    """
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        url = f"http://127.0.0.1:{_server_port()}/object_info/{type_name}"
        with op.open(url, timeout=20) as r:
            data = json.loads(r.read())
        got = data.get(type_name)
        return got if isinstance(got, dict) else {}
    except Exception:
        return {}


def ensure_type(type_name: str) -> dict:
    """拿某个节点的定义：先本地，缺了再单取。返回 {} 表示真的没有。"""
    obj = object_info()
    if type_name in obj:
        return obj[type_name]
    info = _fetch_type_http(type_name)
    if info:
        obj[type_name] = info
    return info


# --------------------------------------------------------------------------
# 节点定义解析
# --------------------------------------------------------------------------

def _is_widget_type(ty, meta) -> bool:
    """是不是「widget 型」输入（而非连线型）。

    新版 v3 schema 里 COMBO 的类型串就是 ``"COMBO"``，选项藏在 ``meta.options``，
    不像老版直接给一个 list。只判断 isinstance(ty, list) 会漏掉
    QwenImage21Cache 的 device / dtype 这类输入，导致 widgets_values 错位。
    """
    if isinstance(ty, list):
        return True
    if ty in WIDGET_TYPES:
        return True
    if isinstance(meta, dict):
        if "options" in meta or "multiselect" in meta:
            return True
        if "min" in meta and "max" in meta:
            return True
    return False


def widget_names(info: dict) -> list[str]:
    """按 object_info 顺序返回「需要 widget 的输入名」。"""
    names = []
    for sec in ("required", "optional"):
        for k, v in ((info.get("input") or {}).get(sec) or {}).items():
            meta = v[1] if len(v) > 1 else {}
            if _is_widget_type(v[0], meta):
                names.append(k)
    return names


def widget_defaults(info: dict) -> dict:
    out = {}
    for sec in ("required", "optional"):
        for k, v in ((info.get("input") or {}).get(sec) or {}).items():
            meta = v[1] if len(v) > 1 else {}
            if not _is_widget_type(v[0], meta):
                continue
            if "default" in meta:
                out[k] = meta["default"]
            elif isinstance(v[0], list) and v[0]:
                out[k] = v[0][0]
            elif "options" in meta and meta["options"]:
                out[k] = meta["options"][0]
            elif v[0] == "STRING":
                out[k] = ""
            elif v[0] == "BOOLEAN":
                out[k] = False
            elif v[0] in ("INT", "FLOAT"):
                out[k] = meta.get("min", 0)
    return out


def link_inputs(info: dict) -> list[tuple[str, str]]:
    """返回 [(输入名, 类型串)]，只含连线型输入，顺序即 UI 的槽位顺序。"""
    out = []
    for sec in ("required", "optional"):
        for k, v in ((info.get("input") or {}).get(sec) or {}).items():
            meta = v[1] if len(v) > 1 else {}
            if _is_widget_type(v[0], meta):
                continue
            ty = v[0] if isinstance(v[0], str) else "COMBO"
            if ty in ("COMFY_AUTOGROW_V3", "COMFY_DYNAMICCOMBO_V3"):
                continue
            out.append((k, ty))
    return out


def autogrow_map(info: dict) -> dict[str, str]:
    """{image_1: 'images', ...} —— 动态输入名 -> 所属字段名。"""
    m = {}
    for sec in ("required", "optional"):
        for k, v in ((info.get("input") or {}).get(sec) or {}).items():
            if v[0] in ("COMFY_AUTOGROW_V3", "COMFY_DYNAMICCOMBO_V3"):
                tpl = (v[1] or {}).get("template") or {}
                for nm in (tpl.get("names") or []):
                    m[nm] = k
    return m


def autogrow_names(info: dict) -> dict[str, list[str]]:
    """{'images': ['image_1', ...]} —— 反查，给 api_to_ui 用。"""
    m: dict[str, list[str]] = {}
    for sec in ("required", "optional"):
        for k, v in ((info.get("input") or {}).get(sec) or {}).items():
            if v[0] in ("COMFY_AUTOGROW_V3", "COMFY_DYNAMICCOMBO_V3"):
                tpl = (v[1] or {}).get("template") or {}
                m[k] = list(tpl.get("names") or [])
    return m


# --------------------------------------------------------------------------
# UI -> API
# --------------------------------------------------------------------------

def ui_to_api(ui: dict, obj: dict | None = None) -> tuple[dict, list[str]]:
    obj = obj or object_info()
    nodes = ui.get("nodes") or []
    raw_links = ui.get("links") or []
    links = {}
    for l in raw_links:
        if isinstance(l, dict):          # 有些版本存成对象
            links[l.get("id")] = {
                "origin_id": l.get("origin_id"), "origin_slot": l.get("origin_slot"),
                "target_id": l.get("target_id"), "target_slot": l.get("target_slot"),
            }
        elif isinstance(l, (list, tuple)) and len(l) >= 5:
            links[l[0]] = {"origin_id": l[1], "origin_slot": l[2],
                           "target_id": l[3], "target_slot": l[4]}

    api: dict[str, dict] = {}
    issues: list[str] = []

    for node in nodes:
        t = node.get("type")
        if node.get("mode") in (2, 4):     # 被 mute / bypass
            continue
        info = obj.get(t) or ensure_type(t)
        if not info:
            if t in UI_ONLY_NODES:
                continue
            issues.append(f"节点类型不存在：{t}")
            continue

        wnames = widget_names(info)
        agmap = autogrow_map(info)
        vals = list(node.get("widgets_values") or [])

        inputs: dict = {}
        vi = 0
        for wn in wnames:
            if vi >= len(vals):
                break
            inputs[wn] = vals[vi]
            vi += 1
            if wn in SEED_NAMES:
                vi += 1                   # 跳过 control_after_generate

        for port in (node.get("inputs") or []):
            lk = port.get("link")
            if lk is None or lk not in links:
                continue
            src = links[lk]
            key = port.get("name") or ""
            if key in agmap:              # autogrow -> 点号路径
                key = f"{agmap[key]}.{key}"
            inputs[key] = [str(src["origin_id"]), src["origin_slot"]]

        api[str(node.get("id"))] = {"class_type": t, "inputs": inputs}

    # 连线指向了不存在的节点
    for nid, n in api.items():
        for k, v in n["inputs"].items():
            if isinstance(v, list) and len(v) == 2 and str(v[0]).isdigit():
                if str(v[0]) not in api:
                    issues.append(f"{n['class_type']}.{k} 指向不存在的节点 {v[0]}")

    return api, issues


# --------------------------------------------------------------------------
# API -> UI（自动布局，用于把内置模板做成可编辑的画布文件）
# --------------------------------------------------------------------------

def api_to_ui(api: dict, obj: dict | None = None, title: str = "") -> dict:
    obj = obj or object_info()

    # ---- 先算深度，决定左右列 ----
    deps: dict[str, set] = {}
    for nid, node in api.items():
        d = set()
        for v in (node.get("inputs") or {}).values():
            if isinstance(v, list) and len(v) == 2 and str(v[0]) in api:
                d.add(str(v[0]))
        deps[nid] = d

    depth: dict[str, int] = {}

    def _depth(nid, stack=()):
        if nid in depth:
            return depth[nid]
        if nid in stack:
            return 0
        if not deps.get(nid):
            depth[nid] = 0
            return 0
        depth[nid] = 1 + max(_depth(x, stack + (nid,)) for x in deps[nid])
        return depth[nid]

    for nid in api:
        _depth(nid)

    # ---- 建节点 ----
    nodes = []
    ui_nodes: dict[str, dict] = {}
    by_col: dict[int, list[str]] = {}
    for nid in api:
        by_col.setdefault(depth.get(nid, 0), []).append(nid)

    # 排序：同列按 class_type 稳定排，避免每次生成位置乱跳
    for col in by_col:
        by_col[col].sort(key=lambda n: (api[n]["class_type"], int(n) if n.isdigit() else 0))

    order = 0
    for col in sorted(by_col):
        for row, nid in enumerate(by_col[col]):
            node_def = api[nid]
            t = node_def["class_type"]
            info = obj.get(t) or ensure_type(t)
            if not info:
                # 静默生成一个空节点是最坏的结果：JSON 合法、一跑就报
                # 「Required input is missing」，而且错得毫无线索
                raise RuntimeError(
                    f"缺少节点定义：{t} —— object_info 取不到这个类型，无法生成画布"
                )
            wnames = widget_names(info)
            defaults = widget_defaults(info)

            vals = []
            for wn in wnames:
                vals.append(node_def["inputs"].get(wn, defaults.get(wn, "")))
                if wn in SEED_NAMES:
                    vals.append("fixed")   # control_after_generate

            outs = []
            out_names = info.get("output_name") or info.get("output") or []
            for i, ty in enumerate(info.get("output") or []):
                nm = out_names[i] if i < len(out_names) else str(ty)
                outs.append({"name": nm, "type": ty, "slot_index": i, "links": []})

            ins = []
            for nm, ty in link_inputs(info):
                ins.append({"name": nm, "type": ty, "link": None})

            h = 46 + max(1, len(wnames)) * 24
            if info.get("output"):
                h = max(h, 46 + len(info["output"]) * 22)

            node = {
                "id": int(nid) if str(nid).isdigit() else abs(hash(nid)) % 100000,
                "type": t,
                "pos": [int(col * 300), int(row * 190)],
                "size": [264, min(360, h)],
                "flags": {},
                "order": order,
                "mode": 0,
                "inputs": ins,
                "outputs": outs,
                "properties": {"Node name for S&R": t},
                "widgets_values": vals,
            }
            order += 1
            nodes.append(node)
            ui_nodes[nid] = node

    # ---- 建连线 ----
    links = []
    lid = 0
    for nid, node_def in api.items():
        dst = ui_nodes.get(nid)
        if not dst:
            continue
        info = obj.get(node_def["class_type"]) or {}
        ins_names = [x["name"] for x in dst["inputs"]]
        ag = autogrow_map(info)
        ag_names = autogrow_names(info)

        for key, val in (node_def.get("inputs") or {}).items():
            if not (isinstance(val, list) and len(val) == 2):
                continue

            # 反解 autogrow 点号路径：images.image_1 -> 字段 images，槽名 image_1
            if "." in key:
                head, tail = key.split(".", 1)
                if head in ag_names and tail in ag_names[head]:
                    want_name = tail
                else:
                    continue
            elif key in ins_names:
                want_name = key
            elif key in ag:
                want_name = key
            else:
                continue

            if want_name not in ins_names:
                dst["inputs"].append({"name": want_name, "type": "*", "link": None})
                ins_names.append(want_name)

            slot = ins_names.index(want_name)
            src_id = str(val[0])
            src = ui_nodes.get(src_id)
            if not src:
                continue
            oslot = int(val[1])
            while len(src["outputs"]) <= oslot:
                src["outputs"].append({"name": f"out{len(src['outputs'])}",
                                       "type": "*", "links": []})
            ltype = src["outputs"][oslot].get("type") or "*"

            lid += 1
            links.append([lid, src["id"], oslot, dst["id"], slot, ltype])
            src["outputs"][oslot]["links"].append(lid)
            dst["inputs"][slot]["link"] = lid

    return {
        "id": "cw_preset_" + (title or "workflow"),
        "revision": 0,
        "last_node_id": max([n["id"] for n in nodes], default=0),
        "last_link_id": lid,
        "nodes": nodes,
        "links": links,
        "groups": [],
        "config": {},
        "extra": {"ds": {"scale": 1, "offset": [40, 40]}},
        "version": 0.4,
    }


# --------------------------------------------------------------------------
# 占位符渲染（在 API 格式上做，UI 里存的是字面量 {{prompt}}）
# --------------------------------------------------------------------------

def render(api: dict, values: dict) -> dict:
    return _P._render(api, values)


def find_value(ui: dict, node_type: str, input_name: str):
    """在 UI 格式里找一个 widget 的值（给「读回可调参数」用）。"""
    obj = object_info()
    for node in ui.get("nodes") or []:
        if node.get("type") != node_type:
            continue
        info = obj.get(node_type) or {}
        wnames = widget_names(info)
        vals = list(node.get("widgets_values") or [])
        vi = 0
        for wn in wnames:
            if vi >= len(vals):
                break
            if wn == input_name:
                return vals[vi]
            vi += 1
            if wn in SEED_NAMES:
                vi += 1
    return None


def set_value(ui: dict, node_type: str, input_name: str, value) -> int:
    """把 UI 格式里某个 widget 改成指定值，返回改了几个节点。"""
    obj = object_info()
    hits = 0
    for node in ui.get("nodes") or []:
        if node.get("type") != node_type:
            continue
        info = obj.get(node_type) or {}
        wnames = widget_names(info)
        vals = list(node.get("widgets_values") or [])
        vi = 0
        for wn in wnames:
            if vi >= len(vals):
                break
            if wn == input_name:
                vals[vi] = value
                node["widgets_values"] = vals
                hits += 1
                break
            vi += 1
            if wn in SEED_NAMES:
                vi += 1
    return hits
