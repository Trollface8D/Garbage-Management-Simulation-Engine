import mimetypes
from pathlib import Path

from google.genai.types import Part

from ....infra.io_utils import read_text
from ....infra.paths import (
    AUDIO_MIME_MAP,
    DEFAULT_EXAMPLE_TEXT_INPUT,
    DEFAULT_MEDIA_DIR,
    ROOT_DIR,
    SUPPORTED_AUDIO_EXTENSIONS,
)
from ..adapters.gemini_client import GeminiGateway


def resolve_input_path(input_path: Path | None) -> Path | None:
    if input_path is None:
        return None

    candidates = [
        input_path,
        ROOT_DIR / input_path,
        ROOT_DIR / "Engine" / input_path,
        DEFAULT_MEDIA_DIR / input_path,
        DEFAULT_MEDIA_DIR / input_path.name,
    ]

    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate

    return input_path


def get_audio_mime_type(audio_path: Path) -> str:
    suffix = audio_path.suffix.lower()
    if suffix in AUDIO_MIME_MAP:
        return AUDIO_MIME_MAP[suffix]

    guessed_mime, _ = mimetypes.guess_type(str(audio_path))
    if guessed_mime and guessed_mime.startswith("audio/"):
        return guessed_mime
    return "audio/mpeg"


def transcribe_audio(gateway: GeminiGateway, audio_path: Path) -> str:
    prompt = (
        "Transcribe this Thai/English interview audio into plain text. "
        "Keep wording faithful and do not summarize."
    )
    response_text = gateway.generate_text(
        prompt,
        parts=[Part.from_bytes(data=audio_path.read_bytes(), mime_type=get_audio_mime_type(audio_path))],
        response_json=False,
    )
    if not response_text.strip():
        raise RuntimeError("Empty transcription result")
    return response_text.strip()


def resolve_input_text(
    gateway: GeminiGateway,
    *,
    input_type: str,
    input_path: Path | None,
    input_text: str | None,
) -> str:
    resolved_path = resolve_input_path(input_path)
    resolved_type = input_type

    if resolved_type == "auto":
        if input_text:
            resolved_type = "text"
        elif resolved_path and resolved_path.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS:
            resolved_type = "audio"
        else:
            resolved_type = "text"

    if resolved_type in {"mp3", "audio"}:
        if not resolved_path:
            raise ValueError("--input-path is required for audio/mp3 input")
        return transcribe_audio(gateway, resolved_path)

    if input_text and input_text.strip():
        return input_text.strip()

    if resolved_path:
        return read_text(resolved_path)

    if DEFAULT_EXAMPLE_TEXT_INPUT.exists():
        return read_text(DEFAULT_EXAMPLE_TEXT_INPUT)

    raise ValueError("Provide --input-text or --input-path")
