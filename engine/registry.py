import torch
from sentence_transformers import SentenceTransformer

class ModelRegistry:
    _instances = {}

    @classmethod
    def get_model(cls, model_name="KaLM-Embedding/KaLM-embedding-multilingual-mini-instruct-v2.5"):
        if model_name not in cls._instances:
            print(f"--- [INIT] Loading Model: {model_name} ---")
            cls._instances[model_name] = SentenceTransformer(
                model_name,
                trust_remote_code=True,
                model_kwargs={"torch_dtype": torch.bfloat16 if torch.cuda.is_available() else torch.float32},
            )
        return cls._instances[model_name]