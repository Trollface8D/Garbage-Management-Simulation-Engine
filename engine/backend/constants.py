from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[2]
EXPERIMENT_DIR = ROOT_DIR / "Experiment"

# Load environment variables from workspace root .env if present.
load_dotenv(ROOT_DIR / ".env")

DEFAULT_CAUSAL_PROMPT = (
    EXPERIMENT_DIR
    / "causal_extraction"
    / "data_extract"
    / "prompt"
    / "causal_extract"
    / "v6_2.txt"
)
DEFAULT_FOLLOW_UP_PROMPT = EXPERIMENT_DIR / "follow-up_question" / "prompt" / "v3.txt"
DEFAULT_ENTITY_EXTRACTION_PROMPT = (
    EXPERIMENT_DIR
    / "code_generation"
    / "entity_design"
    / "entity"
    / "prompt"
    / "entity_extraction"
    / "entity_extraction_prompt_2.md"
)
DEFAULT_ENTITY_GENERATION_PROMPT = (
    EXPERIMENT_DIR
    / "code_generation"
    / "entity_design"
    / "entity"
    / "prompt"
    / "generation"
    / "causal_prompt_gen4.md"
)
DEFAULT_ENTITY_TEMPLATE_DIR = (
    EXPERIMENT_DIR
    / "code_generation"
    / "entity_design"
    / "entity"
    / "gemini_3_pro_entity"
)
DEFAULT_OUTPUT_ROOT = ROOT_DIR / "Engine" / "output" / "pipeline_runs"
DEFAULT_MEDIA_DIR = ROOT_DIR / "Engine" / "media"
DEFAULT_EXAMPLE_TEXT_INPUT = DEFAULT_MEDIA_DIR / "transcript.txt"
DEFAULT_MODEL_NAME = "gemini-3.1-pro"

AUDIO_MIME_MAP: dict[str, str] = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".webm": "audio/webm",
    ".mp4": "audio/mp4",
}

SUPPORTED_AUDIO_EXTENSIONS = set(AUDIO_MIME_MAP.keys())
