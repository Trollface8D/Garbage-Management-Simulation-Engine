# Example for other file: Import the configured variables from your config.py file
# from config import API_KEY
from google.genai.types import GenerateContentConfig, ThinkingConfig
out_as_json = GenerateContentConfig(response_mime_type="application/json", thinking_config=ThinkingConfig(thinking_budget=2048))