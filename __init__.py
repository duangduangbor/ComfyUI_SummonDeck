"""🎭 怪兽牌组 — ComfyUI 插件

把角色 / 场景存成带缩略图的卡片，选几张上台，然后用 @卡名 在提示词里引用它们的参考图。
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# 路由注册发生在 import server 时，必须显式导入一次
from . import server  # noqa: F401

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
