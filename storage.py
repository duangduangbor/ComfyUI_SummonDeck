"""怪兽牌组 —— 数据层。

所有数据落在 ComfyUI/user/default/character_workbench/ 下。
user/ 目录不会被 ComfyUI 更新覆盖，所以卡片是长期安全的。

    user/default/character_workbench/
        library.json          卡片元数据 / 分类 / 工作台 / 快捷按钮 / 设置
        assets/<card_id>/     main.png · thumb.jpg · e_*.png · th_*.jpg
"""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------

def _resolve_root() -> Path:
    try:
        import folder_paths  # type: ignore

        user_dir = Path(folder_paths.get_user_directory())
    except Exception:
        # custom_nodes/<pack>/storage.py -> 上溯三级到 ComfyUI 根
        user_dir = Path(__file__).resolve().parents[2] / "user"
    return user_dir / "default" / "character_workbench"


ROOT = _resolve_root()
ASSETS = ROOT / "assets"
LIB_PATH = ROOT / "library.json"

ROOT.mkdir(parents=True, exist_ok=True)
ASSETS.mkdir(parents=True, exist_ok=True)

THUMB_MAX = 512          # 缩略图最长边
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}

_lock = threading.RLock()

# --------------------------------------------------------------------------
# 默认库
# --------------------------------------------------------------------------

DEFAULT_CATEGORIES = [
    {"id": "cat_character", "name": "角色", "color": "#d9534f", "kind": "character"},
    {"id": "cat_scene", "name": "场景", "color": "#3f8ad4", "kind": "scene"},
    {"id": "cat_prop", "name": "道具", "color": "#c9922e", "kind": "prop"},
]

DEFAULT_LIBRARY = {
    "version": 1,
    "categories": DEFAULT_CATEGORIES,
    "cards": [],
    "workbench": [],
    "quickButtons": [
        {"id": "q_cinema", "label": "电影感", "text": "cinematic lighting, shallow depth of field, film grain, "},
        {"id": "q_clean", "label": "干净白底", "text": "clean white background, studio lighting, product shot, "},
    ],
    "settings": {
        "refTemplate": "image {n}",   # {n} 从 1 开始；也可写 {i} 从 0 开始
        "maxMegapixel": 1.0,          # 参考图限幅，8G 显存友好
        "sendExtras": False,          # @ 一张卡时是否连同补充图一起送
        # 卡片的「角色设定」怎么送：
        #   off  = 完全不送，只送图（最保守）
        #   core = 送身份锚定 + 可变项（推荐，默认）
        #   full = core 之外再送详细设定长文本（可能干扰参考图，慎用）
        "descMode": "core",
        # {ref} 是引用标记（image 1），{name} 卡名，{n}/{i} 序号
        # {identity} 身份锚定，{variable} 可变项，{detail} 详细设定
        "descTemplate": "{ref} 是{name}。外观：{identity}。{variable}。",
    },
}


def _blank_library() -> dict:
    return json.loads(json.dumps(DEFAULT_LIBRARY))


def _migrate(data: dict) -> dict:
    """补齐缺字段，容忍老版本 library.json。"""
    base = _blank_library()
    if not isinstance(data, dict):
        return base
    out = dict(base)
    out.update({k: v for k, v in data.items() if k in base})
    if not isinstance(out.get("categories"), list):
        out["categories"] = base["categories"]
    if not isinstance(out.get("cards"), list):
        out["cards"] = []
    if not isinstance(out.get("workbench"), list):
        out["workbench"] = []
    if not isinstance(out.get("quickButtons"), list):
        out["quickButtons"] = []
    settings = out.get("settings")
    merged = dict(base["settings"])
    if isinstance(settings, dict):
        merged.update(settings)
    out["settings"] = merged

    # 卡片级字段补全
    for card in out["cards"]:
        if not isinstance(card, dict):
            continue
        card.setdefault("kind", "character")
        card.setdefault("categoryId", "")
        card.setdefault("note", "")
        card.setdefault("extras", [])
        card.setdefault("tags", [])
        card.setdefault("main", "")
        card.setdefault("thumb", "")
        card.setdefault("color", "")   # 工作台上的标记色，空 = 不标记

        # 角色设定三件套：@这张卡时随图一起送给模型
        card.setdefault("identity", "")    # 身份锚定：短标签，最有效
        card.setdefault("variable", "")    # 可变项：明确允许模型改什么
        card.setdefault("detail", "")      # 详细设定：人设资料，默认不送
        card.setdefault("descOn", True)    # 这张卡是否参与设定注入
        card.setdefault("coverSource", "")  # 底稿来源：upload / ai
        # 「我亲自来」：用户按视图覆写的补图提示词。
        # 键是视图 key（face/front/.../sheet），值是完整提示词。
        # 有值就用它替代自动拼装的那段，删掉则回到默认。
        card.setdefault("viewPrompts", {})

    # 工作台里已被删掉的卡要清掉
    valid_ids = {c.get("id") for c in out["cards"]}
    out["workbench"] = [i for i in out["workbench"] if i in valid_ids]
    return out


# --------------------------------------------------------------------------
# 读写
# --------------------------------------------------------------------------

def load_library() -> dict:
    with _lock:
        if not LIB_PATH.exists():
            data = _blank_library()
            _write(data)
            return data
        try:
            with open(LIB_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            # 损坏时留个备份再从空库起，别让用户丢光
            try:
                shutil.copy2(LIB_PATH, LIB_PATH.with_suffix(".broken.json"))
            except Exception:
                pass
            data = _blank_library()
        return _migrate(data)


def _write(data: dict) -> None:
    tmp = LIB_PATH.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, LIB_PATH)


def save_library(data: dict) -> dict:
    with _lock:
        data = _migrate(data)
        _write(data)
        return data


def mutate(fn):
    """读-改-写 的原子包装。fn(lib) 就地修改，返回值透传。"""
    with _lock:
        lib = load_library()
        result = fn(lib)
        _write(lib)
        return result


# --------------------------------------------------------------------------
# ID
# --------------------------------------------------------------------------

def new_id(prefix: str = "c") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def now_ts() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------
# 卡片资源
# --------------------------------------------------------------------------

def safe_ext(filename: str) -> str:
    ext = Path(filename or "").suffix.lower()
    return ext if ext in ALLOWED_EXT else ".png"


def card_dir(card_id: str) -> Path:
    d = ASSETS / card_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def abs_asset(rel: str) -> Path | None:
    """把库里的相对路径解析成绝对路径，越界一律拒绝。"""
    if not rel:
        return None
    target = (ASSETS / rel).resolve()
    try:
        target.relative_to(ASSETS.resolve())
    except ValueError:
        return None
    return target if target.is_file() else None


def make_thumb(src: Path, dst: Path, max_side: int = THUMB_MAX) -> bool:
    try:
        from PIL import Image

        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((max_side, max_side), Image.LANCZOS)
            dst.parent.mkdir(parents=True, exist_ok=True)
            im.save(dst, "JPEG", quality=86, optimize=True)
        return True
    except Exception:
        return False


def drop_card_assets(card_id: str) -> None:
    d = ASSETS / card_id
    if d.is_dir():
        try:
            shutil.rmtree(d)
        except Exception:
            pass


def _referenced_rels(card: dict) -> set[str]:
    """卡片里所有被引用到的资源（main / thumb / 每张 extra 的 file + thumb）。"""
    refs = {card.get("main"), card.get("thumb")}
    for e in card.get("extras") or []:
        refs.add(e.get("file"))
        refs.add(e.get("thumb"))
    return {r for r in refs if r}


def card_orphans(card_id: str) -> list[str]:
    """列出这张卡目录下、但已不被库引用的文件（冗余生成图 / 替换残留）。"""
    card = next((c for c in load_library().get("cards", []) if c.get("id") == card_id), None)
    if not card:
        return []
    folder = ASSETS / card_id
    if not folder.is_dir():
        return []
    kept = set()
    for rel in _referenced_rels(card):
        p = abs_asset(rel)
        if p:
            kept.add(p.resolve())
    orphans = []
    for f in folder.iterdir():
        if f.is_file() and f.resolve() not in kept:
            orphans.append(f"{card_id}/{f.name}")
    return sorted(orphans)


def prune_card_orphans(card_id: str) -> int:
    """删掉卡目录下不被引用的文件，返回删掉的个数。

    只碰「本卡目录内、且不在引用表里」的文件 —— 引用表外的任何文件
    （包括用户随手放进去的）都视为冗余生成物，因为插件自己只会往这里
    写 main/thumb/e_*/th_*。谨慎起见不递归、不碰子目录。
    """
    folder = ASSETS / card_id
    if not folder.is_dir():
        return 0
    card = next((c for c in load_library().get("cards", []) if c.get("id") == card_id), None)
    kept = set()
    if card:
        for rel in _referenced_rels(card):
            p = abs_asset(rel)
            if p:
                kept.add(p.resolve())
    n = 0
    for f in folder.iterdir():
        if f.is_file() and f.resolve() not in kept:
            try:
                f.unlink()
                n += 1
            except Exception:
                pass
    return n


# --------------------------------------------------------------------------
# 卡片操作
# --------------------------------------------------------------------------

def create_card(payload: dict) -> dict:
    card = {
        "id": new_id("c"),
        "name": (payload.get("name") or "未命名").strip(),
        "kind": payload.get("kind") or "character",
        "categoryId": payload.get("categoryId") or "",
        "note": payload.get("note") or "",
        "main": "",
        "thumb": "",
        "extras": [],
        "tags": payload.get("tags") or [],
        "color": payload.get("color") or "",
        "identity": payload.get("identity") or "",
        "variable": payload.get("variable") or "",
        "detail": payload.get("detail") or "",
        "descOn": payload.get("descOn", True),
        "createdAt": now_ts(),
    }

    def _do(lib):
        lib["cards"].insert(0, card)   # 新建的排最前
        return card

    return mutate(_do)


def update_card(card_id: str, fields: dict) -> dict | None:
    allowed = {
        "name", "kind", "categoryId", "note", "main", "thumb", "extras", "tags", "color",
        "identity", "variable", "detail", "descOn", "coverSource", "viewPrompts",
    }

    def _do(lib):
        for card in lib["cards"]:
            if card.get("id") == card_id:
                for k, v in fields.items():
                    if k in allowed:
                        card[k] = v
                return card
        return None

    return mutate(_do)


def delete_card(card_id: str) -> bool:
    def _do(lib):
        before = len(lib["cards"])
        lib["cards"] = [c for c in lib["cards"] if c.get("id") != card_id]
        lib["workbench"] = [i for i in lib["workbench"] if i != card_id]
        return len(lib["cards"]) < before

    ok = mutate(_do)
    if ok:
        drop_card_assets(card_id)
    return ok


def set_workbench(ids: list[str]) -> list[str]:
    def _do(lib):
        valid = {c.get("id") for c in lib["cards"]}
        seen, out = set(), []
        for i in ids or []:
            if i in valid and i not in seen:
                seen.add(i)
                out.append(i)
        lib["workbench"] = out
        return out

    return mutate(_do)


# --------------------------------------------------------------------------
# 分类
# --------------------------------------------------------------------------

def add_category(name: str, color: str = "#7a7a7a", kind: str = "custom") -> dict:
    cat = {"id": new_id("cat"), "name": name.strip() or "新分类", "color": color, "kind": kind}

    def _do(lib):
        lib["categories"].append(cat)
        return cat

    return mutate(_do)


def update_category(cat_id: str, fields: dict) -> dict | None:
    allowed = {"name", "color", "kind"}

    def _do(lib):
        for cat in lib["categories"]:
            if cat.get("id") == cat_id:
                for k, v in fields.items():
                    if k in allowed:
                        cat[k] = v
                return cat
        return None

    return mutate(_do)


def delete_category(cat_id: str) -> bool:
    def _do(lib):
        if len(lib["categories"]) <= 1:
            return False
        before = len(lib["categories"])
        lib["categories"] = [c for c in lib["categories"] if c.get("id") != cat_id]
        # 该分类下的卡不删，只是变成「未分类」
        for card in lib["cards"]:
            if card.get("categoryId") == cat_id:
                card["categoryId"] = ""
        return len(lib["categories"]) < before

    return mutate(_do)


def reorder_categories(ids: list[str]) -> list[dict]:
    def _do(lib):
        order = {cid: n for n, cid in enumerate(ids or [])}
        lib["categories"].sort(key=lambda c: order.get(c.get("id"), 999))
        return lib["categories"]

    return mutate(_do)


# --------------------------------------------------------------------------
# 快捷按钮
# --------------------------------------------------------------------------

def add_quick(label: str, text: str) -> dict:
    item = {"id": new_id("q"), "label": label.strip() or "按钮", "text": text or ""}

    def _do(lib):
        lib["quickButtons"].append(item)
        return item

    return mutate(_do)


def update_quick(qid: str, fields: dict) -> dict | None:
    allowed = {"label", "text"}

    def _do(lib):
        for item in lib["quickButtons"]:
            if item.get("id") == qid:
                for k, v in fields.items():
                    if k in allowed:
                        item[k] = v
                return item
        return None

    return mutate(_do)


def delete_quick(qid: str) -> bool:
    def _do(lib):
        before = len(lib["quickButtons"])
        lib["quickButtons"] = [q for q in lib["quickButtons"] if q.get("id") != qid]
        return len(lib["quickButtons"]) < before

    return mutate(_do)


def update_settings(fields: dict) -> dict:
    def _do(lib):
        lib["settings"].update(fields or {})
        return lib["settings"]

    return mutate(_do)


# --------------------------------------------------------------------------
# 给节点用的查询
# --------------------------------------------------------------------------

def card_index() -> dict[str, dict]:
    lib = load_library()
    return {c["id"]: c for c in lib["cards"] if c.get("id")}
