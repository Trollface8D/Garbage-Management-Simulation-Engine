import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Get the API key from the environment variables
# The second argument to os.getenv is a default value if the key is not found
API_KEY = os.getenv("API_KEY")

# Get the database URL
DATABASE_URL = os.getenv("DATABASE_URL")

# Get the debug mode setting (and convert it to a boolean)
# Note: os.getenv returns a string, so 'False' or '0' would still be True.
# This check is more explicit.
DEBUG_MODE = os.getenv("DEBUG_MODE", "False").lower() in ('true', '1', 't')

# Example for other file: Import the configured variables from your config.py file
# from config import API_KEY
from google.genai.types import GenerateContentConfig, ThinkingConfig
out_as_json = GenerateContentConfig(response_mime_type="application/json", thinking_config=ThinkingConfig(thinking_budget=4096))