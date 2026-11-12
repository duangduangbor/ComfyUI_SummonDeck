"""怪兽牌组 —— HTTP 接口。

挂在 ComfyUI 自己的 aiohttp 上，复用它的鉴权/前缀处理。
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import time
import uuid
from pathlib import Path

from aiohttp import web

try:
    from . import storage
except ImportError:
    import storage  # type: ignore

from server import PromptServer

routes = PromptServer.instance.routes
PREFIX = "/character_workbench"


def _json(payload, status: int = 200):
    return web.json_response(
        payload,
        status=status,
        dumps=lambda o: json.dumps(o, ensure_ascii=False),
    )


def ok(data=None):
    return _json({"ok": True, "data": data})


def fail(message: str, status: int = 400):
    return _json({"ok": False, "error": message}, status=status)


async def _body(request) -> dict:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# --------------------------------------------------------------------------
# 读整个库
# --------------------------------------------------------------------------

@routes.get(f"{PREFIX}/library")
async def get_library(request):
    return ok(storage.load_library())


# --------------------------------------------------------------------------
# 卡片
# --------------------------------------------------------------------------

@routes.post(f"{PREFIX}/card/create")
async def card_create(request):
    body = await _body(request)
    card = storage.create_card(body)
    return ok(card)


@routes.post(f"{PREFIX}/card/update")
async def card_update(request):
    body = await _body(request)
    cid = body.pop("id", None)
    if not cid:
        return fail("缺 id")
    card = storage.update_card(cid, body)
    return ok(card) if card else fail("卡片不存在", 404)


@routes.post(f"{PREFIX}/card/delete")
async def card_delete(request):
    body = await _body(request)
    cid = body.get("id")
    if not cid:
        return fail("缺 id")
    return ok({"deleted": storage.delete_card(cid)})


# --------------------------------------------------------------------------
# 工作台
# --------------------------------------------------------------------------

@routes.post(f"{PREFIX}/workbench")
async def set_workbench(request):
    body = await _body(request)
    return ok(storage.set_workbench(body.get("ids") or []))


# --------------------------------------------------------------------------
# 分类
# --------------------------------------------------------------------------

@routes.post(f"{PREFIX}/category/add")
async def category_add(request):
    body = await _body(request)
    return ok(storage.add_category(
        body.get("name") or "新分类",
        body.get("color") or "#7a7a7a",
        body.get("kind") or "custom",
    ))


@routes.post(f"{PREFIX}/category/update")
async def category_update(request):
    body = await _body(request)
    cid = body.pop("id", None)
    if not cid:
        return fail("缺 id")
    cat = storage.update_category(cid, body)
    return ok(cat) if cat else fail("分类不存在", 404)


@routes.post(f"{PREFIX}/category/delete")
async def category_delete(request):
    body = await _body(request)
    cid = body.get("id")
    if not cid:
        return fail("缺 id")
    deleted = storage.delete_category(cid)
    return ok({"deleted": deleted}) if deleted else fail("至少保留一个分类")


@routes.post(f"{PREFIX}/category/reorder")
async def category_reorder(request):
    body = await _body(request)
    return ok(storage.reorder_categories(body.get("ids") or []))


# --------------------------------------------------------------------------
# 快捷按钮
# --------------------------------------------------------------------------

@routes.post(f"{PREFIX}/quick/add")
async def quick_add(request):
    body = await _body(request)
    return ok(storage.add_quick(body.get("label") or "按钮", body.get("text") or ""))


@routes.post(f"{PREFIX}/quick/update")
async def quick_update(request):
    body = await _body(request)
    qid = body.pop("id", None)
    if not qid:
        return fail("缺 id")
    item = storage.update_quick(qid, body)
    return ok(item) if item else fail("按钮不存在", 404)


@routes.post(f"{PREFIX}/quick/delete")
async def quick_delete(request):
    body = await _body(request)
    qid = body.get("id")
    if not qid:
        return fail("缺 id")
    return ok({"deleted": storage.delete_quick(qid)})


# --------------------------------------------------------------------------
# 设置
# --------------------------------------------------------------------------

@routes.post(f"{PREFIX}/settings")
async def set_settings(request):
    body = await _body(request)
    return ok(storage.update_settings(body))


# --------------------------------------------------------------------------
# 资源读取
# --------------------------------------------------------------------------

@routes.get(f"{PREFIX}/asset")
async def get_asset(request):
    rel = request.query.get("path") or ""
    path = storage.abs_asset(rel)
    if not path:
        return web.Response(status=404, text="not found")
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return web.FileResponse(path, headers={"Content-Type": ctype, "Cache-Control": "max-age=60"})


# --------------------------------------------------------------------------
# 上传
# --------------------------------------------------------------------------
# 表单字段：
#   file      必填
#   cardId    可选（不传则新建一张卡）
#   slot      "main"（默认）或 "extra"
#   name      新建卡时的名字

@routes.post(f"{PREFIX}/upload")
async def upload(request):
    try:
        form = await request.post()
    except Exception:
        return fail("需要 multipart 表单")

    field = form.get("file")
    if field is None or not getattr(field, "file", None):
        return fail("没有收到文件")

    raw = field.file.read()
    if not raw:
        return fail("空文件")

    card_id = (form.get("cardId") or "").strip()
    slot = (form.get("slot") or "main").strip()
    name = (form.get("name") or "").strip()

    # 快速参考图：不建卡、不写库，只在 _quick/ 留一个文件。
    # 「用完即扔」的语义要求它和角色卡彻底分离 —— 关掉不看就是垃圾，删了不心疼。
    if slot == "quick":
        folder = storage.quick_dir()
        ext = storage.safe_ext(field.filename or "")
        fpath = folder / f"{uuid.uuid4().hex[:12]}{ext}"
        try:
            fpath.write_bytes(raw)
        except Exception as exc:
            return fail(f"临时图写不进去：{exc}")
        storage.prune_quick()
        rel = f"{storage.QUICK_SUBDIR}/{fpath.name}"
        return ok({"file": rel, "url": f"{PREFIX}/asset?path={rel}"})
    # 手动补图会带上这三样：补的是哪个角度、显示什么名字、从哪来的。
    # 不带也能用（老调用方不传），只是没角度标签。
    view = (form.get("view") or "").strip()
    label = (form.get("label") or "").strip()
    source = (form.get("source") or "").strip()

    created = False
    if not card_id:
        lib = storage.load_library()
        default_cat = (lib.get("categories") or [{}])[0].get("id", "")
        card = storage.create_card({
            "name": name or Path(field.filename or "未命名").stem,
            "categoryId": (form.get("categoryId") or default_cat),
        })
        card_id = card["id"]
        created = True
    else:
        card = storage.update_card(card_id, {})
        if card is None:
            return fail("卡片不存在", 404)

    ext = storage.safe_ext(field.filename or "")
    folder = storage.card_dir(card_id)
    stamp = uuid.uuid4().hex[:8]

    if slot == "extra":
        fname = f"e_{stamp}{ext}"
        tname = f"th_{stamp}.jpg"
    else:
        fname = f"main{ext}"
        tname = "thumb.jpg"

    fpath = folder / fname
    tpath = folder / tname
    fpath.write_bytes(raw)

    if not storage.make_thumb(fpath, tpath):
        # 缩略图失败就直接用原图当缩略图
        tpath = fpath

    rel_file = f"{card_id}/{fname}"
    rel_thumb = f"{card_id}/{tname}"

    if slot == "extra":
        card = storage.update_card(card_id, {})
        extras = list((card or {}).get("extras") or [])

        # 同一个角度只留一张。用户传第二张的意思一定是「换掉这张」，
        # 不是「这个角度存两张」—— 留着反而让"已补过"标记和 @ 时的取舍都变脏。
        if view:
            dropped = [e for e in extras if e.get("view") == view]
            extras = [e for e in extras if e.get("view") != view]
            for old in dropped:
                for key in ("file", "thumb"):
                    old_path = storage.abs_asset(old.get(key) or "")
                    if old_path and old_path.exists() and old_path != fpath:
                        try:
                            old_path.unlink()
                        except Exception:
                            pass

        item = {
            "file": rel_file,
            "thumb": rel_thumb,
            "label": label or view,
            "createdAt": int(time.time() * 1000),
        }
        if view:
            item["view"] = view
        if source:
            item["source"] = source
        extras.append(item)
        card = storage.update_card(card_id, {"extras": extras})
    else:
        card = storage.update_card(card_id, {"main": rel_file, "thumb": rel_thumb})

    return ok({"card": card, "created": created, "url": f"{PREFIX}/asset?path={rel_file}"})


@routes.post(f"{PREFIX}/quick/ref/delete")
async def quick_ref_delete(request):
    """移除一个临时参考图槽时顺手把文件也删了。真删不掉也不影响用。"""
    body = await _body(request)
    rel = (body.get("file") or "").strip()
    if not rel.startswith(f"{storage.QUICK_SUBDIR}/"):
        return fail("只能删临时参考图", 400)
    path = storage.abs_asset(rel)
    if path:
        try:
            path.unlink()
        except Exception as exc:
            return fail(str(exc))
    return ok({"deleted": True})


@routes.post(f"{PREFIX}/extra/delete")
async def extra_delete(request):
    body = await _body(request)
    cid = body.get("id")
    rel = body.get("file")
    if not cid or not rel:
        return fail("缺参数")
    card = storage.update_card(cid, {})
    if not card:
        return fail("卡片不存在", 404)
    # 原图和缩略图是两条记录，只删 file 会留下一堆 th_*.jpg 孤儿，
    # 卡片多了以后目录里全是删不掉的碎片。
    removed = [e for e in (card.get("extras") or []) if e.get("file") == rel]
    extras = [e for e in (card.get("extras") or []) if e.get("file") != rel]
    card = storage.update_card(cid, {"extras": extras})
    for item in removed or [{"file": rel}]:
        for key in ("file", "thumb"):
            target = storage.abs_asset(item.get(key) or "")
            if target:
                try:
                    target.unlink()
                except Exception:
                    pass
    return ok(card)


@routes.post(f"{PREFIX}/asset/delete")
async def asset_delete(request):
    """把卡片的主图清掉（卡还在，变成占位卡）。"""
    body = await _body(request)
    cid = body.get("id")
    if not cid:
        return fail("缺 id")
    card = storage.update_card(cid, {})
    if not card:
        return fail("卡片不存在", 404)
    # 主图、它的缩略图、以及每张补充图的 file + thumb，都要删干净
    rels = [card.get("main"), card.get("thumb")]
    for e in card.get("extras") or []:
        rels += [e.get("file"), e.get("thumb")]
    for rel in [r for r in rels if r]:
        target = storage.abs_asset(rel)
        if target:
            try:
                target.unlink()
            except Exception:
                pass
    card = storage.update_card(cid, {"main": "", "thumb": "", "extras": []})
    return ok(card)


# --------------------------------------------------------------------------
# 补图（预设探测 / 任务 / 单张重跑）
# --------------------------------------------------------------------------

@routes.get(f"{PREFIX}/supplement/presets")
async def supplement_presets(request):
    try:
        from . import probe, preset_store, presets as presets_mod
    except ImportError:
        import probe  # type: ignore
        import preset_store  # type: ignore
        import presets as presets_mod  # type: ignore
    data = await asyncio.to_thread(probe.probe)
    edited = await asyncio.to_thread(
        lambda: {p["id"]: preset_store.has_override(p["id"]) for p in data["presets"]}
    )
    # 每个预设带上「画布改过没有」，前端才能在卡片上标一个小点
    for p in data["presets"]:
        p["edited"] = edited.get(p["id"], False)
    # 视图引导（每个角度该长什么样 + 裁切推荐比例）。
    # 放在后端是因为它和 edit 指令必须说的是同一件事，两边各写一份迟早会飘。
    data["viewInfo"] = presets_mod.view_info()
    return ok(data)


@routes.post(f"{PREFIX}/supplement/refresh")
async def supplement_refresh(request):
    try:
        from . import probe
    except ImportError:
        import probe  # type: ignore
    probe.invalidate()
    return ok(probe.probe())


@routes.post(f"{PREFIX}/supplement/run")
async def supplement_run(request):
    body = await _body(request)
    card_id = body.get("cardId")
    preset_id = body.get("presetId")
    if not card_id or not preset_id:
        return fail("缺 cardId 或 presetId")

    try:
        from . import runner
    except ImportError:
        import runner  # type: ignore

    # 必填项就是 python 的关键字参数名，逐一对上即可
    kwargs = {
        "card_id": card_id,
        "preset_id": preset_id,
        "views": body.get("views"),
        "seed": body.get("seed"),
        "overrides": body.get("overrides") or {},
        "identity": body.get("identity") or "",
        "extra_prompt": body.get("extra") or "",
        "auto_attach": body.get("autoAttach", True),
        "name": body.get("name") or "",
        "variant": body.get("variant") or "",
    }
    try:
        job = runner.create_job(**kwargs)
    except ValueError as e:
        return fail(str(e))
    except Exception as e:
        return fail(f"任务创建失败：{e}", 500)
    return ok(runner.snapshot(job["id"]))


@routes.get(f"{PREFIX}/supplement/job")
async def supplement_job(request):
    try:
        from . import runner
    except ImportError:
        import runner  # type: ignore
    jid = request.query.get("id") or ""
    snap = runner.snapshot(jid)
    if not snap:
        return fail("任务不存在", 404)
    return ok(snap)


@routes.get(f"{PREFIX}/supplement/recent")
async def supplement_recent(request):
    try:
        from . import runner
    except ImportError:
        import runner  # type: ignore
    return ok(runner.recent())


@routes.get(f"{PREFIX}/supplement/active")
async def supplement_active(request):
    """这张卡当前有没有在跑的补图任务（关了面板再打开要能接回去）。"""
    cid = request.query.get("cardId") or ""
    if not cid:
        return fail("缺 cardId")
    try:
        from . import runner
    except ImportError:
        import runner  # type: ignore
    return ok(runner.active_for(cid))


@routes.post(f"{PREFIX}/supplement/rerun")
async def supplement_rerun(request):
    """单张重跑 —— 只重跑一个视图，其他不动。

    两种入口：
      {jobId, key}       会话内的任务项（快，但重启后失效）
      {cardId, file}     从已入库补图重建（补图入库时记了 presetId/seed/view，
                         所以隔天重启也能用，这是常用入口）
    """
    body = await _body(request)

    try:
        from . import runner
    except ImportError:
        import runner  # type: ignore

    card_id = body.get("cardId")
    file = body.get("file")
    if card_id and file:
        try:
            solo = runner.rerun_asset(card_id=card_id, file=file,
                                      new_seed=body.get("newSeed", True))
        except ValueError as e:
            return fail(str(e))
        return ok(runner.snapshot(solo["id"]))

    jid = body.get("jobId")
    key = body.get("key")
    if not jid or not key:
        return fail("缺参数：要么给 cardId + file，要么给 jobId + key")
    try:
        solo = runner.rerun_item(job_id=jid, item_key=key,
                                 new_seed=body.get("newSeed", True))
    except ValueError as e:
        return fail(str(e))
    return ok(runner.snapshot(solo["id"]))


@routes.post(f"{PREFIX}/supplement/cancel")
async def supplement_cancel(request):
    body = await _body(request)
    try:
        from . import runner
    except ImportError:
        import runner  # type: ignore
    done = await runner.cancel_job(body.get("id") or "")
    return ok({"cancelled": done})


@routes.post(f"{PREFIX}/supplement/cancel-item")
async def supplement_cancel_item(request):
    """取消任务里的某一个视图（不生成这一格），其余照常跑。"""
    body = await _body(request)
    jid = body.get("id") or ""
    key = body.get("key") or ""
    if not jid or not key:
        return fail("缺 id / key")
    try:
        from . import runner
    except ImportError:
        import runner  # type: ignore
    done = await runner.cancel_item(jid, key)
    return ok({"cancelled": done})


@routes.post(f"{PREFIX}/supplement/prompt-preview")
async def supplement_prompt_preview(request):
    """返回某张卡某个视图的「默认提示词 + 当前生效提示词」。

    给「我亲自来」弹窗用：用户要看到原始提示词才能改，改完要能还原。
    default 是自动拼装的结果（不含用户覆写），current 是含覆写后的实际值。
    """
    body = await _body(request)
    card_id = body.get("cardId")
    view = body.get("view") or ""
    preset_id = body.get("presetId") or ""
    if not card_id or not view or not preset_id:
        return fail("缺 cardId / view / presetId")

    try:
        from . import presets as P
        from . import sheet_templates as ST
    except ImportError:
        import presets as P  # type: ignore
        import sheet_templates as ST  # type: ignore

    preset = P.get_preset(preset_id)
    if not preset:
        return fail(f"未知预设：{preset_id}", 404)

    card = next((c for c in storage.load_library().get("cards", [])
                 if c.get("id") == card_id), None)
    if not card:
        return fail("卡片不存在", 404)

    identity = body.get("identity") or card.get("identity") or ""
    extra = body.get("extra") or ""
    name = card.get("name") or ""
    variant = body.get("variant") or ""

    mode = preset.get("mode", "set")
    if mode == "sheet":
        default_prompt = ST.build_sheet_prompt(
            preset_id, identity=identity, extra=extra, name=name, variant=variant)
    else:
        default_prompt = P.compose_edit_prompt(identity, view, extra)

    overrides = card.get("viewPrompts") or {}
    current = (overrides.get(view) if isinstance(overrides, dict) else "") or default_prompt

    return ok({
        "view": view,
        "presetId": preset_id,
        "default": default_prompt,
        "current": current,
        "overridden": bool(overrides.get(view)) if isinstance(overrides, dict) else False,
    })


@routes.post(f"{PREFIX}/card/orphans")
async def card_orphans(request):
    """列出这张卡目录下不被引用的冗余文件（替换残留 / 多余生成图）。"""
    body = await _body(request)
    cid = body.get("id")
    if not cid:
        return fail("缺 id")
    return ok({"orphans": storage.card_orphans(cid)})


@routes.post(f"{PREFIX}/card/prune")
async def card_prune(request):
    """删掉这张卡目录下不被引用的冗余文件。"""
    body = await _body(request)
    cid = body.get("id")
    if not cid:
        return fail("缺 id")
    return ok({"removed": storage.prune_card_orphans(cid)})


# --------------------------------------------------------------------------
# 底稿生成（新建角色时「让 AI 画一张」）
# --------------------------------------------------------------------------

@routes.post(f"{PREFIX}/cover/generate")
async def cover_generate(request):
    body = await _body(request)
    card_id = body.get("cardId")
    preset_id = body.get("presetId")
    if not card_id or not preset_id:
        return fail("缺 cardId 或 presetId")

    try:
        from . import runner
    except ImportError:
        import runner  # type: ignore

    try:
        job = runner.create_cover_job(
            card_id=card_id,
            preset_id=preset_id,
            subject=body.get("subject") or "",
            seed=body.get("seed"),
            ratio=body.get("ratio") or "portrait",
            overrides=body.get("overrides") or {},
        )
    except ValueError as e:
        return fail(str(e))
    except Exception as e:
        return fail(f"任务创建失败：{e}", 500)
    return ok(runner.snapshot(job["id"]))


# --------------------------------------------------------------------------
# 预设工作流（画布编辑 / 保存 / 重置）
# --------------------------------------------------------------------------

@routes.get(f"{PREFIX}/preset/get")
async def preset_get(request):
    preset_id = request.query.get("id") or ""
    if not preset_id:
        return fail("缺 id")
    try:
        from . import preset_store
    except ImportError:
        import preset_store  # type: ignore
    try:
        payload = await asyncio.to_thread(
            lambda: {"ui": preset_store.get_ui(preset_id),
                     "meta": preset_store.meta(preset_id)}
        )
    except ValueError as e:
        return fail(str(e), 404)
    return ok(payload)


@routes.get(f"{PREFIX}/preset/meta")
async def preset_meta(request):
    preset_id = request.query.get("id") or ""
    try:
        from . import preset_store
    except ImportError:
        import preset_store  # type: ignore
    if preset_id:
        return ok(await asyncio.to_thread(preset_store.meta, preset_id))
    try:
        from . import presets as P
    except ImportError:
        import presets as P  # type: ignore
    ids = P.preset_ids()
    return ok(await asyncio.to_thread(
        lambda: [preset_store.meta(pid) for pid in ids]
    ))


@routes.post(f"{PREFIX}/preset/save")
async def preset_save(request):
    body = await _body(request)
    preset_id = body.get("id")
    ui = body.get("ui")
    if not preset_id or not isinstance(ui, dict):
        return fail("缺 id 或 ui")
    try:
        from . import preset_store
    except ImportError:
        import preset_store  # type: ignore
    try:
        meta = await asyncio.to_thread(preset_store.save_ui, preset_id, ui)
        meta = await asyncio.to_thread(preset_store.meta, preset_id)
    except ValueError as e:
        return fail(str(e))
    return ok(meta)


@routes.post(f"{PREFIX}/preset/reset")
async def preset_reset(request):
    body = await _body(request)
    preset_id = body.get("id")
    if not preset_id:
        return fail("缺 id")
    try:
        from . import preset_store
    except ImportError:
        import preset_store  # type: ignore
    try:
        await asyncio.to_thread(preset_store.reset, preset_id)
        meta = await asyncio.to_thread(preset_store.meta, preset_id)
    except ValueError as e:
        return fail(str(e))
    return ok(meta)


@routes.post(f"{PREFIX}/preset/validate")
async def preset_validate(request):
    """不落盘，先验一遍画布能不能跑 —— 让前端在保存前给出准确报错。"""
    body = await _body(request)
    ui = body.get("ui")
    if not isinstance(ui, dict):
        return fail("缺 ui")
    try:
        from . import workflow_io as W
    except ImportError:
        import workflow_io as W  # type: ignore
    api, issues = await asyncio.to_thread(W.ui_to_api, ui)
    types = {n["class_type"] for n in api.values()}
    return ok({
        "nodes": len(api),
        "issues": issues[:8],
        "hasOutput": ("SaveImage" in types) or ("PreviewImage" in types),
        "ok": bool(api) and not issues and (("SaveImage" in types) or ("PreviewImage" in types)),
    })


print("[怪兽牌组] HTTP 接口已挂载 →", PREFIX)
