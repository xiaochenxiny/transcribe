from faster_whisper import WhisperModel
from av.error import InvalidDataError
import logging

# 强制使用 CPU，避免触发 CUDA / cuBLAS 依赖错误
model = WhisperModel(
    "small",
    device="cpu",
    compute_type="int8",
)


def transcribe_audio(file_path: str, language: str = "auto") -> str:
    """
    对单个音频文件进行转写。
    为了兼容前端分片上传的 webm/opus 短音频分段，这里对解码失败做了兜底处理：
    - 遇到 InvalidDataError 时返回空字符串，而不是抛出 500。
    这样前端只会跳过这一小段，不会影响整个会话。
    """
    try:
        # 只支持中文 / 英文优先配置，其它情况走自动检测
        kwargs = dict(
    vad_filter=True,
    beam_size=8,          # 从 5 提升到 8 或 10，提升解码搜索质量
    best_of=5,            # 让模型在多条候选里选最优
    temperature=0.2,      # 减少“发挥”
)
        if language in {"zh", "en"}:
            kwargs["language"] = language

        segments, info = model.transcribe(file_path, **kwargs)
    except InvalidDataError as e:
        logging.warning(f"音频解码失败，文件可能为空或编码不兼容: {file_path} - {e}")
        return ""
    except Exception as e:
        logging.error(f"Whisper 转写异常: {file_path} - {e}")
        return ""

    text_parts = []
    for segment in segments:
        if segment.text and segment.text.strip():
            text_parts.append(segment.text.strip())

    return " ".join(text_parts).strip()