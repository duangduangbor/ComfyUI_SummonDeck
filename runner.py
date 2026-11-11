"""怪兽牌组 —— 补图 / 底稿任务执行器。

一次任务 = 一个 job，job 里有若干 item（每个视图一个）。
item 是最小可重跑单位：单张不满意，重跑那个 item 即可，不影响其他。

执行策略
--------
- **串行**：8G 显存经不起并行，一个 job 内的 item 依次提交，
  全局也只允许一个 job 在跑。
- **自请求**：通过 ComfyUI 自己的 HTTP 接口提交 ``/prompt``，
  免得踩内部队列 API 的版本差异。
- **画布即真相**：每次执行都把 ``preset_store`` 里当前生效的 UI 画布
  转成 API 再打值，所以用户在画布上改的东西立刻生效，不用重启。
- **结果落盘**：从 /history 拿输出文件名，复制进卡片 assets。
  补图进 extras，底稿进 main。
"""

from __future__ import annotations

import asyncio
import copy
import json
import random
import shutil
import time
import uuid
from pathlib import Path

try:
    from . import preset_store
    from . import presets as P
    from . import probe
    from . import storage
    from . import workflow_io as W
except ImportError:
    import preset_store  # type: ignore
    import presets as P  # type: ignore
    import probe  # type: ignore
    import storage  # type: ignore
    import workflow_io as W  # type: ignore


JOBS: dict[str, dict] = {}
MAX_JOBS = 40          # 内存里最多留这么多个 job 记录


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def _now() -> int:
    return int(time.time() * 1000)


def _new_job_id() -> str:
    return f"j_{uuid.uuid4().hex[:10]}"


def _server():
    from server import PromptServer  # type: ignore
    return PromptServer.instance


def _input_dir() -> Path:
    try:
        import folder_paths  # type: ignore
        return Path(folder_paths.get_input_directory())
    except Exception:
        return Path(__file__).resolve().parents[2] / "input"


def _output_dir() -> Path:
    try:
        import folder_paths  # type: ignore
        return Path(folder_paths.get_output_directory())
    except Exception:
        return Path(__file__).resolve().parents[2] / "output"


def _prune() -> None:
    if len(JOBS) <= MAX_JOBS:
        return
    done = [j for j in JOBS.values() if j["status"] in ("done", "failed", "cancelled")]
    done.sort(key=lambda j: j.get("createdAt", 0))
    for j in done[: len(JOBS) - MAX_JOBS]:
        JOBS.pop(j["id"], None)


def _card(card_id: str) -> dict | None:
    return next((c for c in storage.load_library().get("cards", [])
                 if c.get("id") == card_id), None)


# --------------------------------------------------------------------------
# 输入图
# --------------------------------------------------------------------------

def _stage_input(card_id: str) -> str:
    """把卡片底稿放进 ComfyUI 的 input 目录，返回文件名。

    用内容哈希命名，同一张图重复补图不会堆一堆副本；
    换了底稿会得到新名字，旧的自然失效（不删，避免误删正在排队的任务）。
    """
    hit = _card(card_id)
    if not hit:
        raise ValueError("卡片不存在")

    rel = hit.get("main") or ""
    src = storage.abs_asset(rel)
    if not src:
        for e in hit.get("extras") or []:
            src = storage.abs_asset(e.get("file"))
            if src:
                break
    if not src:
        raise ValueError("这张卡还没有底稿，先放一张图再补图")

    data = src.read_bytes()
    import hashlib
    tag = hashlib.sha1(data).hexdigest()[:12]
    name = f"cw_in_{card_id}_{tag}{src.suffix.lower() or '.png'}"
    dst = _input_dir() / name
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        dst.write_bytes(data)
    return name


# --------------------------------------------------------------------------
# 与 ComfyUI 通信
# --------------------------------------------------------------------------

async def _post_prompt(workflow: dict, client_id: str) -> str:
    import aiohttp

    port = getattr(_server(), "port", 8188)
    url = f"http://127.0.0.1:{port}/prompt"
    payload = {"prompt": workflow, "client_id": client_id}
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=payload,
                                timeout=aiohttp.ClientTimeout(total=30)) as r:
            text = await r.text()
            if r.status != 200:
                raise RuntimeError(f"提交失败 HTTP {r.status}: {text[:400]}")
            data = json.loads(text)
    pid = data.get("prompt_id")
    if not pid:
        raise RuntimeError(f"没拿到 prompt_id：{text[:300]}")
    return pid


async def _wait_prompt(prompt_id: str, job: dict, item: dict, timeout: float = 900.0) -> dict:
    """轮询 /history 直到出结果。顺便把队列状态同步给前端。"""
    import aiohttp

    port = getattr(_server(), "port", 8188)
    base = f"http://127.0.0.1:{port}"
    start = time.time()

    async with aiohttp.ClientSession() as session:
        while True:
            if job.get("cancelled"):
                # 用普通异常而不是 CancelledError：后者会让 asyncio
                # 认为整个 task 被取消，收尾逻辑就不执行了
                raise RuntimeError("__cancelled__")

            if time.time() - start > timeout:
                raise TimeoutError("等出图超时")

            try:
                async with session.get(f"{base}/history/{prompt_id}",
                                       timeout=aiohttp.ClientTimeout(total=10)) as r:
                    hist = await r.json()
            except Exception:
                hist = {}

            if prompt_id in hist:
                entry = hist[prompt_id]
                status = entry.get("status") or {}
                if status.get("status_str") == "error":
                    msgs = status.get("messages") or []
                    raise RuntimeError(f"执行报错：{json.dumps(msgs, ensure_ascii=False)[:400]}")
                return entry

            try:
                async with session.get(f"{base}/queue",
                                       timeout=aiohttp.ClientTimeout(total=8)) as r:
                    q = await r.json()
                running = q.get("queue_running") or []
                pending = q.get("queue_pending") or []
                is_running = any(len(x) > 1 and x[1] == prompt_id for x in running)
                item["queue"] = 0 if is_running else len(pending)
                item["stage"] = "sampling" if is_running else "queued"
            except Exception:
                pass

            await asyncio.sleep(1.2)


def _extract_images(entry: dict) -> list[dict]:
    out = []
    for _node_id, node_out in (entry.get("outputs") or {}).items():
        for img in (node_out.get("images") or []):
            if img.get("type") == "temp":
                continue
            out.append(img)
    return out


# --------------------------------------------------------------------------
# 结果入卡
# --------------------------------------------------------------------------

def _write_png(src: Path, dst: Path) -> bool:
    try:
        from PIL import Image
        with Image.open(src) as im:
            im.convert("RGB").save(dst, "PNG", optimize=True)
        return True
    except Exception:
        try:
            shutil.copy2(src, dst)
            return True
        except Exception:
            return False


def _absorb_result(card_id: str, item: dict, preset_id: str,
                   seed: int, target: str = "extra") -> dict | None:
    """把出图复制进卡片 assets。

    ``target="extra"`` 追加/替换补充图；``target="main"`` 直接当底稿。
    带 ``replace``（单张重跑）时替换旧的那条并删旧文件 ——
    否则补十次卡里会堆十张。
    """
    src_rel = item.get("_out")
    if not src_rel:
        return None
    src = _output_dir() / src_rel
    if not src.is_file():
        return None

    folder = storage.card_dir(card_id)
    stamp = uuid.uuid4().hex[:8]

    if target == "main":
        fname, tname = "main.png", "thumb.jpg"
    else:
        fname, tname = f"e_{stamp}.png", f"th_{stamp}.jpg"

    fpath, tpath = folder / fname, folder / tname
    if not _write_png(src, fpath):
        return None
    if not storage.make_thumb(fpath, tpath):
        tpath, tname = fpath, fname

    rel_file = f"{card_id}/{fname}"
    rel_thumb = f"{card_id}/{tname}"

    if target == "main":
        def _do(lib):
            for card in lib["cards"]:
                if card.get("id") == card_id:
                    card["main"] = rel_file
                    card["thumb"] = rel_thumb
                    card["coverSource"] = "ai"
                    return card
            return None

        storage.mutate(_do)
        return {"file": rel_file, "thumb": rel_thumb, "target": "main"}

    new_extra = {
        "file": rel_file,
        "thumb": rel_thumb,
        "label": item.get("label") or "",
        "source": "supplement",
        "presetId": preset_id,
        "seed": seed,
        "view": item.get("key", ""),
        "createdAt": _now(),
    }

    old_file = item.get("replace") or ""
    replaced = {"hit": False}

    def _do(lib):
        for card in lib["cards"]:
            if card.get("id") == card_id:
                extras = list(card.get("extras") or [])
                if old_file:
                    for idx, e in enumerate(extras):
                        if e.get("file") == old_file:
                            extras[idx] = new_extra
                            replaced["hit"] = True
                            break
                    else:
                        extras.append(new_extra)
                else:
                    extras.append(new_extra)
                card["extras"] = extras
                return card
        return None

    storage.mutate(_do)

    if replaced["hit"]:
        for gone in item.get("replaceAll") or []:
            tgt = storage.abs_asset(gone)
            if tgt:
                try:
                    tgt.unlink()
                except Exception:
                    pass
    return new_extra


# --------------------------------------------------------------------------
# 组工作流
# --------------------------------------------------------------------------

def _build_workflow(preset: dict, ui: dict, models: dict, *,
                    prompt: str, negative: str, seed: int,
                    width: int, height: int, prefix: str) -> dict:
    api, issues = W.ui_to_api(ui)
    if issues:
        raise ValueError("工作流有问题：" + "；".join(issues[:3]))
    if not api:
        raise ValueError("工作流是空的")

    values = {
        "prompt": prompt,
        "negative": negative if negative is not None else "",
        "seed": int(seed) & 0xFFFFFFFF,
        "width": int(width),
        "height": int(height),
        "prefix": prefix,
        "image": models.get("image", ""),
        "unet": models.get("unet", ""),
        "clip": models.get("clip", ""),
        "vae": models.get("vae", ""),
        "lora": models.get("lora", ""),
        "ckpt": models.get("ckpt", ""),
    }
    return P.apply_inject(copy.deepcopy(api), preset, values)


def _prompt_for(preset: dict, job: dict, item: dict) -> str:
    opts = job.get("options") or {}
    mode = preset.get("mode", "set")

    if mode == "t2i":
        return P.compose_cover_prompt(opts.get("subject") or opts.get("identity") or "")

    if mode == "sheet":
        # 整表模板来自 sheet_templates：触发句不能动，改的是身份条目
        try:
            from . import sheet_templates as ST
        except ImportError:
            import sheet_templates as ST  # type: ignore
        return ST.build_sheet_prompt(
            preset["id"],
            identity=opts.get("identity") or "",
            extra=opts.get("extra") or "",
            name=opts.get("name") or "",
            variant=opts.get("variant") or "",
        )

    return P.compose_edit_prompt(
        opts.get("identity") or "", item["key"], opts.get("extra") or ""
    )


def _negative_for(preset: dict, job: dict) -> str:
    mode = preset.get("mode", "set")
    if mode == "sheet":
        try:
            from . import sheet_templates as ST
        except ImportError:
            import sheet_templates as ST  # type: ignore
        return ST.sheet_negative(preset["id"])
    return preset.get("negative") or ""


# --------------------------------------------------------------------------
# job 生命周期
# --------------------------------------------------------------------------

def _make_job(*, kind: str, card_id: str, preset_id: str, items: list[dict],
              seed: int, options: dict, mode: str) -> dict:
    job = {
        "id": _new_job_id(),
        "kind": kind,
        "cardId": card_id,
        "presetId": preset_id,
        "mode": mode,
        "status": "queued",
        "items": items,
        "seed": seed,
        "options": options,
        "createdAt": _now(),
        "cancelled": False,
        "error": "",
    }
    JOBS[job["id"]] = job
    _prune()
    asyncio.create_task(_run_job(job))
    return job


def create_job(*, card_id: str, preset_id: str, views: list[str] | None = None,
               seed: int | None = None, overrides: dict | None = None,
               identity: str = "", extra_prompt: str = "",
               auto_attach: bool = True, name: str = "", variant: str = "") -> dict:
    preset = P.get_preset(preset_id)
    if not preset:
        raise ValueError(f"未知预设：{preset_id}")
    if preset.get("mode") == "t2i":
        raise ValueError("这是底稿生成预设，请用「生成底稿」入口")

    data = probe.probe()
    entry = next((p for p in data["presets"] if p["id"] == preset_id), None)
    if not entry:
        raise ValueError("预设不存在")
    if not entry["available"]:
        raise ValueError("这套预设当前不可用：" + "；".join(entry["missing"]))

    card = _card(card_id)
    if not card:
        raise ValueError("卡片不存在")

    # 卡里存了身份描述就用它，不用用户在补图面板里再抄一遍
    if not identity:
        identity = card.get("identity") or ""
    if not name:
        name = card.get("name") or ""

    mode = preset.get("mode", "set")
    if mode == "sheet":
        view_keys = ["sheet"]
    else:
        view_keys = views or preset.get("views") or P.DEFAULT_SET_VIEWS
        view_keys = [v for v in view_keys if v in P.VIEWS]
        if not view_keys:
            raise ValueError("没有选任何视图")

    base_seed = int(seed) if isinstance(seed, int) and seed >= 0 else random.randint(0, 2**31 - 1)

    items = []
    for vk in view_keys:
        view = P.VIEWS.get(vk) or {"label": "设定表"}
        # 同一批共用一颗 seed：身份相同、只有视图指令不同，
        # 同 seed 能让各视图的笔触和光影最接近。想换就单张重跑。
        w, h = P.size_for(preset, vk)
        items.append({
            "key": vk,
            "label": view.get("label", vk),
            "status": "pending",
            "seed": base_seed,
            "width": w,
            "height": h,
            "queue": -1,
            "stage": "",
            "file": "",
            "thumb": "",
            "error": "",
            "promptId": "",
        })

    return _make_job(
        kind="supplement", card_id=card_id, preset_id=preset_id,
        items=items, seed=base_seed,
        mode=mode,
        options={
            "identity": identity,
            "extra": extra_prompt,
            "overrides": overrides or {},
            "autoAttach": auto_attach,
            "name": name,
            "variant": variant,
        },
    )


def create_cover_job(*, card_id: str, preset_id: str, subject: str,
                     seed: int | None = None, ratio: str = "portrait",
                     overrides: dict | None = None) -> dict:
    """新建角色时「让 AI 画一张底稿」。

    结果直接写成卡片主图 —— 它之后就是所有补图的参考图。
    """
    preset = P.get_preset(preset_id)
    if not preset:
        raise ValueError(f"未知预设：{preset_id}")
    if preset.get("mode") != "t2i":
        raise ValueError("这套预设不是用来生成底稿的")

    data = probe.probe()
    entry = next((p for p in data["presets"] if p["id"] == preset_id), None)
    if not entry or not entry["available"]:
        raise ValueError("模型不全：" + "；".join((entry or {}).get("missing") or ["未知"]))

    if not _card(card_id):
        raise ValueError("卡片不存在")
    if not (subject or "").strip():
        raise ValueError("先写一句想画什么")

    base_seed = int(seed) if isinstance(seed, int) and seed >= 0 else random.randint(0, 2**31 - 1)

    # 底稿默认竖构图（全身），用户选了方形/横构图就按那个来
    sizes = {"portrait": (832, 1216), "square": (1024, 1024), "landscape": (1216, 832)}
    w, h = sizes.get(ratio, sizes["portrait"])

    item = {
        "key": "cover",
        "label": "底稿",
        "status": "pending",
        "seed": base_seed,
        "width": w,
        "height": h,
        "queue": -1,
        "stage": "",
        "file": "",
        "thumb": "",
        "error": "",
        "promptId": "",
        "target": "main",
    }

    return _make_job(
        kind="cover", card_id=card_id, preset_id=preset_id,
        items=[item], seed=base_seed, mode="t2i",
        options={
            "subject": subject,
            "identity": subject,
            "extra": "",
            "overrides": overrides or {},
            "autoAttach": True,
            "name": "",
            "variant": "",
        },
    )


async def _run_job(job: dict) -> None:
    job["status"] = "running"
    preset = P.get_preset(job["presetId"]) or {}
    opts = job.get("options") or {}
    card_id = job["cardId"]

    try:
        # 这几步都是同步阻塞的（读画布、转格式、嗅模型头、拷文件），
        # 直接在事件循环里跑会把整个 ComfyUI 的 HTTP 服务卡住
        ui = await asyncio.to_thread(preset_store.get_ui, job["presetId"])
        models = await asyncio.to_thread(
            probe.resolve_models, job["presetId"], opts.get("overrides")
        )
        if preset.get("needsImage", True):
            models["image"] = await asyncio.to_thread(_stage_input, card_id)
    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
        for it in job["items"]:
            it["status"] = "failed"
            it["stage"] = "failed"
            it["error"] = str(e)
        return

    negative = _negative_for(preset, job)

    for item in job["items"]:
        if job.get("cancelled"):
            item["status"] = "cancelled"
            continue

        item["status"] = "running"
        item["stage"] = "building"
        try:
            prompt = _prompt_for(preset, job, item)
            prefix = f"cw/{card_id}-{job['presetId']}-{item['key']}"
            wf = await asyncio.to_thread(
                _build_workflow, preset, ui, models,
                prompt=prompt, negative=negative, seed=item["seed"],
                width=item.get("width") or 1024, height=item.get("height") or 1024,
                prefix=prefix,
            )

            item["stage"] = "submitting"
            pid = await _post_prompt(wf, f"cw_{job['id']}_{item['key']}")
            item["promptId"] = pid

            entry = await _wait_prompt(pid, job, item)
            imgs = _extract_images(entry)
            if not imgs:
                raise RuntimeError("跑完了但没有输出图，检查工作流里有没有 SaveImage")

            img = imgs[0]
            sub = img.get("subfolder") or ""
            item["_out"] = str(Path(sub) / img["filename"]) if sub else img["filename"]

            if opts.get("autoAttach", True):
                got = await asyncio.to_thread(
                    _absorb_result, card_id, item, job["presetId"], item["seed"],
                    item.get("target") or "extra",
                )
                if not got:
                    item["error"] = "出图成功但入库失败"
                    item["status"] = "failed"
                    continue
                item["file"] = got["file"]
                item["thumb"] = got["thumb"]

            item["status"] = "done"
            item["stage"] = "done"

        except Exception as e:
            if job.get("cancelled"):
                item["status"] = "cancelled"
                item["stage"] = "cancelled"
            else:
                item["status"] = "failed"
                item["stage"] = "failed"
                item["error"] = str(e)[:500]

    if job.get("cancelled"):
        job["status"] = "cancelled"
    elif all(i["status"] == "done" for i in job["items"]):
        job["status"] = "done"
    elif any(i["status"] == "done" for i in job["items"]):
        job["status"] = "partial"
    else:
        job["status"] = "failed"


# --------------------------------------------------------------------------
# 单张重跑
# --------------------------------------------------------------------------

def rerun_item(*, job_id: str, item_key: str, new_seed: bool = True) -> dict:
    """只重跑一个 item。这是「单张不满意就重跑单张」的落点。"""
    job = JOBS.get(job_id)
    if not job:
        raise ValueError("任务不存在（可能已过期），请重新发起补图")
    item = next((i for i in job["items"] if i["key"] == item_key), None)
    if not item:
        raise ValueError("这个视图不在任务里")

    if new_seed:
        item["seed"] = random.randint(0, 2**31 - 1)
    item["status"] = "queued"
    item["stage"] = "queued"
    item["error"] = ""
    item["queue"] = -1

    solo_item = dict(item)
    if item.get("file"):
        solo_item["replace"] = item["file"]
        solo_item["replaceAll"] = [x for x in (item["file"], item.get("thumb")) if x]

    solo = {
        "id": f"{job['id']}_r{uuid.uuid4().hex[:6]}",
        "kind": job.get("kind", "supplement"),
        "cardId": job["cardId"],
        "presetId": job["presetId"],
        "mode": job["mode"],
        "status": "queued",
        "items": [solo_item],
        "seed": solo_item["seed"],
        "options": dict(job.get("options") or {}),
        "createdAt": _now(),
        "cancelled": False,
        "error": "",
        "parent": job_id,
    }
    JOBS[solo["id"]] = solo
    asyncio.create_task(_run_job(solo))
    return solo


def rerun_asset(*, card_id: str, file: str, new_seed: bool = True) -> dict:
    """从一张已入库的补图重建任务，重跑并替换它。

    不依赖内存里的 job —— 入库时已经把 presetId / seed / view 写进 extras，
    所以隔天、重启之后照样能重跑。
    """
    card = _card(card_id)
    if not card:
        raise ValueError("卡片不存在")

    extra = next((e for e in (card.get("extras") or []) if e.get("file") == file), None)
    if not extra:
        raise ValueError("这张图不在卡片的补充图里")

    preset_id = extra.get("presetId") or ""
    if not preset_id:
        raise ValueError("这张图不是补图生成的（没有预设记录），无法原样重跑")

    preset = P.get_preset(preset_id)
    if not preset:
        raise ValueError(f"预设 {preset_id} 已不存在")

    view_key = extra.get("view") or ("sheet" if preset.get("mode") == "sheet" else "front")
    view = P.VIEWS.get(view_key) or {"label": "设定表"}
    w, h = P.size_for(preset, view_key)

    seed = random.randint(0, 2**31 - 1) if new_seed else int(extra.get("seed") or 0)

    item = {
        "key": view_key,
        "label": view.get("label", view_key),
        "status": "queued",
        "seed": seed,
        "width": w,
        "height": h,
        "queue": -1,
        "stage": "queued",
        "file": "",
        "thumb": "",
        "error": "",
        "promptId": "",
        "replace": file,
        "replaceAll": [x for x in (file, extra.get("thumb")) if x],
    }

    solo = {
        "id": f"j_{uuid.uuid4().hex[:10]}",
        "kind": "supplement",
        "cardId": card_id,
        "presetId": preset_id,
        "mode": preset.get("mode", "set"),
        "status": "queued",
        "items": [item],
        "seed": seed,
        "options": {
            "identity": card.get("identity") or "",
            "extra": "",
            "overrides": {},
            "autoAttach": True,
            "name": card.get("name") or "",
            "variant": "",
        },
        "createdAt": _now(),
        "cancelled": False,
        "error": "",
        "rerunOf": file,
    }
    JOBS[solo["id"]] = solo
    _prune()
    asyncio.create_task(_run_job(solo))
    return solo


async def cancel_job(job_id: str) -> bool:
    """取消任务，并且真的把它从 ComfyUI 队列里撤掉。

    只置标志位不够 —— ComfyUI 那边照跑不误，显存一直占着。
    """
    job = JOBS.get(job_id)
    if not job:
        return False
    job["cancelled"] = True
    job["status"] = "cancelling"

    pid = ""
    for it in job["items"]:
        if it.get("promptId") and it.get("status") in ("running", "queued"):
            pid = it["promptId"]
            break
    if not pid:
        return True

    import aiohttp

    port = getattr(_server(), "port", 8188)
    base = f"http://127.0.0.1:{port}"
    try:
        async with aiohttp.ClientSession() as session:
            try:
                await session.post(f"{base}/queue", json={"delete": [pid]},
                                   timeout=aiohttp.ClientTimeout(total=8))
            except Exception:
                pass
            try:
                async with session.get(f"{base}/queue",
                                       timeout=aiohttp.ClientTimeout(total=5)) as r:
                    q = await r.json()
                running = q.get("queue_running") or []
                if any(len(x) > 1 and x[1] == pid for x in running):
                    await session.post(f"{base}/interrupt", json={},
                                       timeout=aiohttp.ClientTimeout(total=8))
            except Exception:
                pass
    except Exception:
        pass
    return True


def snapshot(job_id: str) -> dict | None:
    job = JOBS.get(job_id)
    if not job:
        return None
    out = {k: v for k, v in job.items() if not k.startswith("_")}
    out["items"] = [
        {k: v for k, v in i.items() if not k.startswith("_")}
        for i in job["items"]
    ]
    return out


def recent(limit: int = 8) -> list[dict]:
    jobs = sorted(JOBS.values(), key=lambda j: j.get("createdAt", 0), reverse=True)
    return [snapshot(j["id"]) for j in jobs[:limit]]


def active_for(card_id: str) -> dict | None:
    """这张卡还没跑完的补图任务。

    面板是会被关掉的，但任务在服务端照样跑。重开面板时靠这个把界面接回去，
    否则用户看到一张空白面板，会以为没在跑，再点一次「开始补图」——
    结果是两份任务同时抢显存。
    """
    live = [
        j for j in JOBS.values()
        if j.get("cardId") == card_id
        and j.get("kind") != "cover"
        and j.get("status") not in ("done", "failed", "partial", "cancelled")
    ]
    if not live:
        return None
    live.sort(key=lambda j: j.get("createdAt", 0), reverse=True)
    return snapshot(live[0]["id"])
