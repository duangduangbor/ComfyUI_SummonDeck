"""怪兽牌组 —— 补图预设。

设计原则（这版改过，跟前两版不一样，先看完再动）
------------------------------------------------
1. **只瞄准「吃参考图」的模型**。
   SDXL 那类纯文生图架构，逐张出图靠文本锚不住同一张脸，必须有
   IPAdapter / InstantID 才有戏。这条线已经砍掉——不是它不好，是它
   跟本插件的核心假设（一张底稿衍生出一整套素材）不匹配。
   现在所有预设都满足：**给它底稿，它按底稿出图**。

2. **UI 格式是唯一真相**。
   预设文件存在 ``presets_ui/<id>.json``（内置基线）和
   ``user/.../presets/<id>.json``（用户改过的覆写）。
   执行时用 ``workflow_io.ui_to_api()`` 现转，提交给 ``/prompt``。
   这样「画布上改 → 存回 → 能跑」是同一份数据，不会两边打架。

3. **不在 UI 里塞占位符**。
   早期想把 ``{{prompt}}`` 写进 widget，但 INT 型 widget（seed / width）
   一旦被前端规范化成数字，占位符就没了。改成「真实值 + 注入表」：
   UI 文件里是一份能直接跑的完整工作流（示例提示词、seed 42），
   执行时按 ``inject`` 规则把 prompt / seed / 图片 / 模型名打进去。
   好处是用户在画布上看到的就是真东西，不是一堆 `{{}}`。

4. **注入优先按节点 id，找不到就按类型兜底**。
   用户可能删了原节点重加，id 会变；按 class_type 再找一遍，并且
   positive / negative 两个同类型节点靠「未被占用」区分，不会互相吃。
"""

from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path

# --------------------------------------------------------------------------
# 视图
# --------------------------------------------------------------------------
# 每个视图 = 一次独立出图。参考图驱动的写法跟纯文本完全不同：
# 不是「描述一个人」，而是「把这个人的构图改成 X，其余不变」。
#   ratio: 宽/高
#   edit : 参考图编辑用的指令（英文，这类模型的编码器对指令句最敏感）
#   cover: 生成底稿时不适用

VIEWS: dict[str, dict] = {
    "face": {
        "label": "面部特写",
        "ratio": (1, 1),
        "size": (1024, 1024),
        "tag": "face",
        "edit": (
            "Keep the same character as the reference image: same face, same hairstyle, "
            "same eye color, same facial features, same makeup. "
            "Change the framing to a close-up portrait of the head and shoulders, "
            "looking at the viewer, neutral expression, "
            "plain light gray background, soft even studio lighting, sharp focus on the eyes. "
            "Do not change the identity. No text, no watermark."
        ),
    },
    "front": {
        "label": "正面全身",
        "ratio": (2, 3),
        "size": (832, 1216),
        "tag": "front",
        "edit": (
            "Keep the same character as the reference image: same face, same hairstyle, "
            "same outfit, same colors, same body proportions. "
            "Change the framing to a full body shot, front view, standing straight, "
            "arms relaxed at the sides, entire body visible from head to toe, "
            "plain light gray background, even studio lighting. "
            "Do not change the identity or the outfit. No text, no watermark."
        ),
    },
    "three_q": {
        "label": "四分之三侧",
        "ratio": (2, 3),
        "size": (832, 1216),
        "tag": "3q",
        "edit": (
            "Keep the same character as the reference image: same face, same hairstyle, "
            "same outfit, same colors, same body proportions. "
            "Change the pose to a three-quarter view, body turned about 45 degrees to the side, "
            "still facing the viewer, full body shot, standing straight, "
            "entire body visible from head to toe, plain light gray background, "
            "even studio lighting. Do not change the identity or the outfit. No text, no watermark."
        ),
    },
    "side": {
        "label": "侧面全身",
        "ratio": (2, 3),
        "size": (832, 1216),
        "tag": "side",
        "edit": (
            "Keep the same character as the reference image: same face, same hairstyle, "
            "same outfit, same colors, same body proportions. "
            "Change the pose to a pure side profile view, body facing fully sideways, "
            "full body shot, standing straight, entire body visible from head to toe, "
            "plain light gray background, even studio lighting. "
            "Do not change the identity or the outfit. No text, no watermark."
        ),
    },
    "back": {
        "label": "背面全身",
        "ratio": (2, 3),
        "size": (832, 1216),
        "tag": "back",
        "edit": (
            "Keep the same character as the reference image: same hairstyle, same hair color, "
            "same outfit, same colors, same body proportions. "
            "Change the pose to a full body back view, seen from behind, standing straight, "
            "entire body visible from head to toe, "
            "plain light gray background, even studio lighting. "
            "Do not change the outfit or the proportions. No text, no watermark."
        ),
    },
    "action": {
        "label": "动作姿态",
        "ratio": (2, 3),
        "size": (832, 1216),
        "tag": "action",
        "edit": (
            "Keep the same character as the reference image: same face, same hairstyle, "
            "same outfit, same colors. "
            "Change the pose to a confident standing action pose, slight dynamic angle, "
            "full body visible from head to toe, plain light gray background, "
            "even studio lighting. Do not change the identity or the outfit. No text, no watermark."
        ),
    },
    "expression": {
        "label": "表情集",
        "ratio": (1, 1),
        "size": (1024, 1024),
        "tag": "expr",
        "edit": (
            "Keep the same character as the reference image: same face, same hairstyle, "
            "same eye color. Show a sheet of four head-and-shoulders expression studies of "
            "this same character: neutral, smiling, surprised, serious. "
            "Evenly spaced on a plain light gray background, same lighting across all four. "
            "Do not change the identity between them. No text, no watermark."
        ),
    },
}

DEFAULT_SET_VIEWS = ["face", "front", "three_q", "side", "back"]


# --------------------------------------------------------------------------
# 每个视图「该长什么样」
# --------------------------------------------------------------------------
# 这段文案有两个用处，缺一不可：
#   1. 面板上直接印在视图旁边 —— 用户不知道"侧面全身"到底要拍到什么程度，
#      给了句子才知道自己手机里那张够不够用；
#   2. 引导**手动上传**。AI 出图有 edit 指令兜底，人传图没有，
#      写不清楚就会传一张只有半张脸、裁出来全是肩膀的图。
#
# aspect 是裁切器打开时的默认比例：脸和表情是方图，全身是 2:3 竖图。

VIEW_GUIDES: dict[str, dict] = {
    "face": {
        "guide": "头部到肩，正对镜头，眼睛看镜头，背景干净",
        "aspect": (1, 1),
    },
    "front": {
        "guide": "全身站直，双臂自然下垂，正面朝镜头，头顶到脚都在画面里",
        "aspect": (2, 3),
    },
    "three_q": {
        "guide": "身体侧转约 45°，脸仍朝镜头，全身",
        "aspect": (2, 3),
    },
    "side": {
        "guide": "正侧身 90°，全身，能看清鼻尖到后脑的轮廓线",
        "aspect": (2, 3),
    },
    "back": {
        "guide": "背对镜头，全身，能看清后脑和后背的服装结构",
        "aspect": (2, 3),
    },
    "action": {
        "guide": "一个典型动作姿势，全身，别裁到手脚",
        "aspect": (2, 3),
    },
    "expression": {
        "guide": "同一张脸的表情小拼图（平静 / 微笑 / 惊讶 / 严肃），或单张大头照",
        "aspect": (1, 1),
    },
}


def view_info() -> dict:
    """给前端用的视图说明表。key 就是 presets 里 views 数组的元素。"""
    out: dict[str, dict] = {}
    for key, view in VIEWS.items():
        extra = VIEW_GUIDES.get(key, {})
        ratio = extra.get("aspect") or view.get("ratio") or (1, 1)
        out[key] = {
            "key": key,
            "label": view.get("label", key),
            "guide": extra.get("guide", ""),
            "aspect": [int(ratio[0]), int(ratio[1])],
            "size": list(view.get("size") or []),
        }
    return out


# --------------------------------------------------------------------------
# 架构族识别
# --------------------------------------------------------------------------

FAMILY_RULES: list[tuple[str, list[str]]] = [
    ("flux2",  ["flux-2*", "flux2*", "*flux2*"]),
    ("krea",   ["krea2*", "krea-2*", "*krea2*"]),
    ("qwen",   ["qwen_image*", "qwen-image*", "*qwen*image*"]),
    ("flux1",  ["flux1*", "flux-1*", "*flux1-dev*", "*flux1-schnell*", "*flux_dev*"]),
    ("sdxl",   ["*xl*", "pony*", "illustrious*", "noob*", "animagine*", "anima*",
                "*sdxl*", "*-xl-*", "*_xl_*"]),
]


def guess_family(filename: str) -> str:
    low = (filename or "").lower()
    for fam, patterns in FAMILY_RULES:
        for p in patterns:
            if fnmatch.fnmatch(low, p.lower()):
                return fam
    return ""


def sniff_family(model_dict: dict) -> str:
    """解析 safetensors 头里的层命名判断架构。

    文件名常常乱起（本机 ``noctQUncensoredRealism...`` 其实是 Qwen-Image），
    所以必须看张量名。只读头部几 MB，不加载权重。

    实测判据：
      SDXL      conditioner.embedders.1（两个文本编码器）+ input_blocks
      SD1.5     conditioner.embedders.0 + input_blocks
      FLUX.1    double_blocks + single_blocks + guidance_in / vector_in
      FLUX.2    double_blocks + single_blocks + double_stream_modulation_img
      Krea 2    blocks.N.attn.wq + txtfusion
      Qwen      transformer_blocks + txt_in + img_in + modulation + norm_out
    """
    path = (model_dict or {}).get("path") or ""
    if not path:
        return ""
    try:
        import struct

        p = Path(path)
        if not p.is_file():
            return ""
        with open(p, "rb") as fh:
            n = struct.unpack("<Q", fh.read(8))[0]
            header = json.loads(fh.read(min(n, 5_000_000)))
        keys = [k for k in header if k != "__metadata__"]
        if not keys:
            return ""
        joined = "\n".join(re.sub(r"^model\.diffusion_model\.", "", k) for k in keys)

        if "conditioner.embedders.1" in joined:
            return "sdxl"
        if "conditioner.embedders.0" in joined or "input_blocks" in joined:
            return "sd15"
        if "txtfusion" in joined:
            return "krea"
        if "double_blocks" in joined:
            if "guidance_in" in joined or "vector_in" in joined:
                return "flux1"
            return "flux2"
        if "transformer_blocks" in joined and "txt_in" in joined and "img_in" in joined:
            return "qwen"
        if "cap_embedder" in joined:
            return "sd3"
    except Exception:
        return ""
    return ""


# --------------------------------------------------------------------------
# 预设
# --------------------------------------------------------------------------
# need 的值：list = 只约束架构族；dict = 族 + 文件名特征（更精确）
# inject   ：执行时往哪几个节点的哪个输入打值
# views    ：set 模式可选视图
# viewSizes：per-view 画幅；缺省的用 size.base 按 ratio 算

PRESETS: list[dict] = [
    # ------------------------------------------------------------------
    # Qwen-Image 2.1 —— 主力。参考图编辑，逐张出图，单张可重跑
    # ------------------------------------------------------------------
    {
        "id": "qwen_edit",
        "label": "Qwen-Image 2.1 · 逐张补图",
        "family": "qwen",
        "mode": "set",
        "needsImage": True,
        "hint": "拿底稿当参考图，逐张改成别的视角。参考图驱动，身份靠图锚定，"
                "单张不满意只重跑那一张。",
        "need": {
            "unet": {"families": ["qwen"],
                     "patterns": ["*qwen_image_2.1*", "*qwen_image*", "*qwen*"]},
            "clip": {"patterns": ["*qwen3vl_8b*", "*qwenImage21*", "*qwen3vl*", "*qwen*"]},
            "vae":  {"patterns": ["*qwen_image_2.1_vae*", "*qwen_image_vae*", "*qwen*vae*"]},
        },
        "views": DEFAULT_SET_VIEWS,
        "size": {"base": 1024, "max": 1280},
        "steps": 20,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "inject": [
            {"key": "unet", "type": "UNETLoader", "input": "unet_name"},
            {"key": "clip", "type": "CLIPLoader", "input": "clip_name"},
            {"key": "vae", "type": "VAELoader", "input": "vae_name"},
            {"key": "image", "type": "LoadImage", "input": "image"},
            {"key": "prompt", "node": "6", "type": "TextEncodeQwenImage21", "input": "prompt"},
            {"key": "negative", "node": "6", "type": "TextEncodeQwenImage21",
             "input": "negative_prompt"},
            {"key": "seed", "type": "KSampler", "input": "seed"},
            {"key": "width", "type": "EmptyLatentImage", "input": "width"},
            {"key": "height", "type": "EmptyLatentImage", "input": "height"},
            {"key": "prefix", "type": "SaveImage", "input": "filename_prefix"},
        ],
        # 参考图驱动时负向几乎无效（cfg=1.0），留空
        "negative": "",
        "workflow": {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "qwen_image_2.1_int8_convrot.safetensors",
                             "weight_dtype": "default"}},
            "2": {"class_type": "CLIPLoader",
                  "inputs": {"clip_name": "qwen3vl_8b_w4a8.safetensors",
                             "type": "qwen_image", "device": "default"}},
            "3": {"class_type": "VAELoader",
                  "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
            "4": {"class_type": "QwenImage21Cache",
                  "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
            "5": {"class_type": "LoadImage", "inputs": {"image": "cw_reference.png"}},
            "6": {"class_type": "TextEncodeQwenImage21",
                  "inputs": {"clip": ["2", 0],
                             "prompt": "full body shot, front view, standing straight",
                             "negative_prompt": "", "vae": ["3", 0], "resolution": 0,
                             "images.image_1": ["5", 0]}},
            "7": {"class_type": "EmptyLatentImage",
                  "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
            "8": {"class_type": "KSampler",
                  "inputs": {"model": ["4", 0], "positive": ["6", 0], "negative": ["6", 1],
                             "latent_image": ["7", 0], "seed": 42, "steps": 20, "cfg": 1.0,
                             "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
            "9": {"class_type": "VAEDecode",
                  "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
            "10": {"class_type": "SaveImage",
                   "inputs": {"images": ["9", 0], "filename_prefix": "cw_supplement"}},
        },
    },

    # ------------------------------------------------------------------
    # FLUX.2 Klein —— 四视图整表
    # ------------------------------------------------------------------
    {
        "id": "flux2_sheet",
        "label": "FLUX.2 Klein · 四视图设定表",
        "family": "flux2",
        "mode": "sheet",
        "needsImage": True,
        "hint": "QuadView LoRA 一次画出「面部特写 + 正面 / 侧面 / 背面全身」。"
                "整表模式：各格联合生成，只能整张重跑。",
        "need": {
            "unet": {"families": ["flux2"],
                     "patterns": ["*flux-2-klein-9b-fp8*", "*flux-2-klein*", "*flux-2*"]},
            "clip": {"patterns": ["*qwen_3_8b*", "*qwen3vl*"]},
            "vae":  {"patterns": ["*flux2-vae*", "*flux2*vae*"]},
            "lora": {"patterns": ["*quadview*", "*tripleview*"]},
        },
        "variants": [
            {"id": "quad", "label": "四视图（含面部特写）", "lora": "*quadview*"},
            {"id": "triple", "label": "纯三视图", "lora": "*tripleview*"},
        ],
        "size": {"fixed": (1536, 1024)},
        "steps": 8,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "inject": [
            {"key": "unet", "type": "UNETLoader", "input": "unet_name"},
            {"key": "lora", "type": "LoraLoaderModelOnly", "input": "lora_name"},
            {"key": "clip", "type": "CLIPLoader", "input": "clip_name"},
            {"key": "vae", "type": "VAELoader", "input": "vae_name"},
            {"key": "image", "type": "LoadImage", "input": "image"},
            {"key": "prompt", "node": "7", "type": "CLIPTextEncode", "input": "text"},
            {"key": "negative", "node": "8", "type": "CLIPTextEncode", "input": "text"},
            {"key": "seed", "type": "RandomNoise", "input": "noise_seed"},
            {"key": "prefix", "type": "SaveImage", "input": "filename_prefix"},
        ],
        "negative": (
            "bad quality, noise, blurry, worst quality, low resolution, blur, distortion, "
            "unnatural blending"
        ),
        "workflow": {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "flux-2-klein-9b-fp8.safetensors",
                             "weight_dtype": "default"}},
            "2": {"class_type": "LoraLoaderModelOnly",
                  "inputs": {"model": ["1", 0],
                             "lora_name": "QuadView_klein9b_v1.safetensors",
                             "strength_model": 0.9}},
            "3": {"class_type": "CLIPLoader",
                  "inputs": {"clip_name": "qwen_3_8b_fp8mixed.safetensors",
                             "type": "flux2", "device": "default"}},
            "4": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
            "5": {"class_type": "LoadImage", "inputs": {"image": "cw_reference.png"}},
            "6": {"class_type": "ResizeAndPadImage",
                  "inputs": {"image": ["5", 0], "target_width": 1536, "target_height": 1024,
                             "padding_color": "white", "interpolation": "lanczos"}},
            "9": {"class_type": "VAEEncode", "inputs": {"pixels": ["6", 0], "vae": ["4", 0]}},
            "7": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "Convert the character in the image to a Character Sheet.",
                             "clip": ["3", 0]}},
            "8": {"class_type": "CLIPTextEncode",
                  "inputs": {"text": "bad quality, noise, blurry", "clip": ["3", 0]}},
            "10": {"class_type": "ReferenceLatent",
                   "inputs": {"conditioning": ["7", 0], "latent": ["9", 0]}},
            "11": {"class_type": "ReferenceLatent",
                   "inputs": {"conditioning": ["8", 0], "latent": ["9", 0]}},
            "12": {"class_type": "BasicScheduler",
                   "inputs": {"model": ["2", 0], "scheduler": "simple",
                              "steps": 8, "denoise": 1.0}},
            "13": {"class_type": "CFGGuider",
                   "inputs": {"model": ["2", 0], "positive": ["10", 0],
                              "negative": ["11", 0], "cfg": 1.0}},
            "14": {"class_type": "RandomNoise", "inputs": {"noise_seed": 42}},
            "15": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
            "16": {"class_type": "EmptyFlux2LatentImage",
                   "inputs": {"width": 1536, "height": 1024, "batch_size": 1}},
            "17": {"class_type": "SamplerCustomAdvanced",
                   "inputs": {"noise": ["14", 0], "guider": ["13", 0],
                              "sampler": ["15", 0], "sigmas": ["12", 0],
                              "latent_image": ["16", 0]}},
            "18": {"class_type": "VAEDecode", "inputs": {"samples": ["17", 0], "vae": ["4", 0]}},
            "19": {"class_type": "SaveImage",
                   "inputs": {"images": ["18", 0], "filename_prefix": "cw_supplement"}},
        },
    },

    # ------------------------------------------------------------------
    # Krea 2 —— 七区设定表
    # ------------------------------------------------------------------
    {
        "id": "krea_sheet",
        "label": "Krea 2 · 七区设定表",
        "family": "krea",
        "mode": "sheet",
        "needsImage": True,
        "hint": "DynamicCharacterSheet 一次画出七区实体设定表（信息栏 / 英雄视图 / "
                "三视图 / 动作 / 剪影 / 表情 / 细节）。整表模式，只能整张重跑。",
        "need": {
            "unet": {"families": ["krea"],
                     "patterns": ["*krea2_turbo*", "*krea2 turbo*", "*krea2*"]},
            "clip": {"patterns": ["*qwen3vl_4b*", "*qwen3vl*"]},
            "vae":  {"patterns": ["*qwen_image_vae*", "*qwen*vae*"]},
            "lora": {"patterns": ["*dynamiccharactersheet*", "*character*sheet*"]},
        },
        "size": {"fixed": (1536, 1024)},
        "steps": 10,
        "cfg": 1.0,
        "sampler": "lcm",
        "scheduler": "simple",
        "inject": [
            {"key": "unet", "type": "UNETLoader", "input": "unet_name"},
            {"key": "lora", "type": "LoraLoaderModelOnly", "input": "lora_name"},
            {"key": "clip", "type": "CLIPLoader", "input": "clip_name"},
            {"key": "vae", "type": "VAELoader", "input": "vae_name"},
            {"key": "image", "type": "LoadImage", "input": "image"},
            {"key": "prompt", "node": "7", "type": "Krea2EditGroundedEncode", "input": "prompt"},
            {"key": "negative", "node": "8", "type": "Krea2EditGroundedEncode",
             "input": "prompt"},
            {"key": "seed", "type": "KSampler", "input": "seed"},
            {"key": "prefix", "type": "SaveImage", "input": "filename_prefix"},
        ],
        "negative": "",
        "workflow": {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "krea2_turbo_fp8_scaled.safetensors",
                             "weight_dtype": "default"}},
            "2": {"class_type": "LoraLoaderModelOnly",
                  "inputs": {"model": ["1", 0],
                             "lora_name": "DynamicCharacterSheet_krea2_v1.safetensors",
                             "strength_model": 1.0}},
            "3": {"class_type": "CLIPLoader",
                  "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors",
                             "type": "krea2", "device": "default"}},
            "4": {"class_type": "VAELoader",
                  "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
            "5": {"class_type": "LoadImage", "inputs": {"image": "cw_reference.png"}},
            "6": {"class_type": "VAEEncode", "inputs": {"pixels": ["5", 0], "vae": ["4", 0]}},
            "7": {"class_type": "Krea2EditGroundedEncode",
                  "inputs": {"clip": ["3", 0],
                             "prompt": "Convert the subject into a character sheet.",
                             "image": ["5", 0], "grounding_px": 768}},
            "8": {"class_type": "Krea2EditGroundedEncode",
                  "inputs": {"clip": ["3", 0], "prompt": "",
                             "image": ["5", 0], "grounding_px": 768}},
            "9": {"class_type": "Krea2EditModelPatch",
                  "inputs": {"model": ["2", 0], "source_latent": ["6", 0],
                             "ref_boost": 4.0, "ref_boost_a": 1.0, "fit_mode": "fit",
                             "vae": ["4", 0], "source_image": ["5", 0],
                             "target_latent": ["10", 0]}},
            "10": {"class_type": "EmptySD3LatentImage",
                   "inputs": {"width": 1536, "height": 1024, "batch_size": 1}},
            "11": {"class_type": "KSampler",
                   "inputs": {"model": ["9", 0], "seed": 42, "steps": 10, "cfg": 1.0,
                              "sampler_name": "lcm", "scheduler": "simple",
                              "positive": ["7", 0], "negative": ["8", 0],
                              "latent_image": ["10", 0], "denoise": 1.0}},
            "12": {"class_type": "VAEDecode",
                   "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
            "13": {"class_type": "SaveImage",
                   "inputs": {"images": ["12", 0], "filename_prefix": "cw_supplement"}},
        },
    },

    # ------------------------------------------------------------------
    # 底稿生成（文生图）—— 新建角色时「让 AI 画一张」
    # ------------------------------------------------------------------
    {
        "id": "qwen_t2i",
        "label": "Qwen-Image 2.1 · 生成底稿",
        "family": "qwen",
        "mode": "t2i",
        "needsImage": False,
        "hint": "没有现成图时，用一段描述先画一张底稿。画完可以再裁、再补图。",
        "need": {
            "unet": {"families": ["qwen"],
                     "patterns": ["*qwen_image_2.1*", "*qwen_image*", "*qwen*"]},
            "clip": {"patterns": ["*qwen3vl_8b*", "*qwenImage21*", "*qwen3vl*", "*qwen*"]},
            "vae":  {"patterns": ["*qwen_image_2.1_vae*", "*qwen_image_vae*", "*qwen*vae*"]},
        },
        "size": {"base": 1024, "max": 1280},
        "steps": 20,
        "cfg": 1.0,
        "sampler": "euler",
        "scheduler": "simple",
        "inject": [
            {"key": "unet", "type": "UNETLoader", "input": "unet_name"},
            {"key": "clip", "type": "CLIPLoader", "input": "clip_name"},
            {"key": "vae", "type": "VAELoader", "input": "vae_name"},
            {"key": "prompt", "type": "TextEncodeQwenImage21", "input": "prompt"},
            {"key": "seed", "type": "KSampler", "input": "seed"},
            {"key": "width", "type": "EmptyLatentImage", "input": "width"},
            {"key": "height", "type": "EmptyLatentImage", "input": "height"},
            {"key": "prefix", "type": "SaveImage", "input": "filename_prefix"},
        ],
        "negative": "",
        "workflow": {
            "1": {"class_type": "UNETLoader",
                  "inputs": {"unet_name": "qwen_image_2.1_int8_convrot.safetensors",
                             "weight_dtype": "default"}},
            "2": {"class_type": "CLIPLoader",
                  "inputs": {"clip_name": "qwen3vl_8b_w4a8.safetensors",
                             "type": "qwen_image", "device": "default"}},
            "3": {"class_type": "VAELoader",
                  "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
            "4": {"class_type": "QwenImage21Cache",
                  "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
            "5": {"class_type": "TextEncodeQwenImage21",
                  "inputs": {"clip": ["2", 0],
                             "prompt": "full body character design, standing, plain background",
                             "negative_prompt": "", "resolution": 1024}},
            "6": {"class_type": "EmptyLatentImage",
                  "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
            "7": {"class_type": "KSampler",
                  "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["5", 1],
                             "latent_image": ["6", 0], "seed": 42, "steps": 20, "cfg": 1.0,
                             "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
            "8": {"class_type": "VAEDecode",
                  "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
            "9": {"class_type": "SaveImage",
                  "inputs": {"images": ["8", 0], "filename_prefix": "cw_cover"}},
        },
    },
]


def get_preset(preset_id: str) -> dict | None:
    for p in PRESETS:
        if p["id"] == preset_id:
            return p
    return None


def preset_ids() -> list[str]:
    return [p["id"] for p in PRESETS]


# --------------------------------------------------------------------------
# 尺寸
# --------------------------------------------------------------------------

def size_for(preset: dict, view_key: str, quality: float = 1.0) -> tuple[int, int]:
    """按视图比例和预设基准尺寸算像素，对齐到 8 的倍数。

    ``size.fixed`` 的预设（整表）直接返回训练画幅 —— 实测改画幅会让
    QuadView 多出一格、七区表直接崩布局。
    """
    fixed = (preset.get("size") or {}).get("fixed")
    if fixed:
        return int(fixed[0]), int(fixed[1])

    view = VIEWS.get(view_key) or {}
    fixed_view = view.get("size")
    if fixed_view:
        k = max(0.4, min(1.5, quality))
        return (int(round(fixed_view[0] * k / 8) * 8),
                int(round(fixed_view[1] * k / 8) * 8))

    base = (preset.get("size") or {}).get("base", 1024) * max(0.4, min(1.5, quality))
    cap = int((preset.get("size") or {}).get("max", 1536))
    rw, rh = view.get("ratio", (2, 3))
    if rw >= rh:
        w, h = base, base * rh / rw
    else:
        w, h = base * rw / rh, base
    w = max(384, min(cap, int(round(w / 8) * 8)))
    h = max(384, min(cap, int(round(h / 8) * 8)))
    return w, h


# --------------------------------------------------------------------------
# 注入
# --------------------------------------------------------------------------

def _resolve_targets(api: dict, rule: dict, claimed: set) -> list[str]:
    """把一条注入规则翻译成实际节点 id。

    优先按声明的 node id（用户没动过的图最准）；id 不在图里、或那个位置
    已经不是原来的节点类型了，就按 class_type 找一个「还没被占用」的。
    """
    want = rule.get("node")
    typ = rule.get("type")
    if want and str(want) in api and (not typ or api[str(want)]["class_type"] == typ):
        return [str(want)]

    same = [k for k, v in api.items() if v["class_type"] == typ]
    free = [k for k in same if k not in claimed]
    return free or same


def apply_inject(api: dict, preset: dict, values: dict) -> dict:
    """把 prompt / seed / 图片 / 模型名打进 API 工作流。

    ``values`` 的键就是 inject 规则里的 key。没给值的规则跳过 ——
    这样「用户改过工作流、少了某个节点」不会炸，只会少打一处。
    """
    claimed: set = set()
    for rule in preset.get("inject") or []:
        key = rule.get("key")
        if key not in values:
            continue
        val = values[key]
        if val is None or val == "":
            # 负向可能是空字符串，那是有效值；只有 None / 空键才跳过
            if key in ("negative", "prompt"):
                pass
            else:
                continue
        field = rule.get("input")
        for nid in _resolve_targets(api, rule, claimed):
            claimed.add(nid)
            api[nid].setdefault("inputs", {})[field] = val
    return api


def compose_edit_prompt(identity: str, view_key: str, extra: str = "") -> str:
    """参考图编辑的提示词：指令在前，身份标签补在后面。

    顺序有讲究：这类模型对「保持什么不变 / 改成什么」的指令句最敏感，
    身份标签是补充。反过来写会被当成氛围词，反而把人往描述的样子拉。
    """
    view = VIEWS.get(view_key) or {}
    parts = [view.get("edit") or ""]
    ident = (identity or "").strip().rstrip("。.")
    if ident:
        parts.append(f"Identity details to preserve: {ident}.")
    tail = (extra or "").strip().rstrip("。.")
    if tail:
        parts.append(tail + ".")
    return " ".join(p for p in parts if p)


def compose_cover_prompt(subject: str) -> str:
    """生成底稿的提示词。补一句构图约束，否则容易出半身或满背景。"""
    body = (subject or "").strip().rstrip("。.")
    base = ("full body character, standing straight, facing the viewer, "
            "entire body visible from head to toe, plain light gray background, "
            "even studio lighting, clean design, no text, no watermark")
    return f"{body}. {base}" if body else base
