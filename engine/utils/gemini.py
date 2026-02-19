from google import genai
from google.genai.types import GenerateContentConfig, GoogleSearch, Tool, Part, Content
from pathlib import Path
import io

class GeminiClient:
    def __init__(
        self,
                project_id: str = None,
                location: str = None,
                key: str = None,
                ):
        self.client = None
        
        # Prioritize API key authentication over Vertex AI
        # API key is simpler and doesn't require gcloud authentication
        if key:
            self.client = genai.Client(api_key=key)

                
        # Only use Vertex AI if API key is not available or failed
        if self.client is None and project_id:
            self.client = genai.Client(
                vertexai=True, project=project_id, location=location
            )
                
        if self.client is None:
            raise Exception("Failed to initialize GeminiClient. Please check your API key or Vertex AI credentials.")
            
        self.cost_per_million_input = 0.15
        self.cost_per_million_output = 0.60

    def generate(
            self, 
            prompt: str,
            generation_config: GenerateContentConfig,
            model_name: str = "gemini-2.5-flash-preview-04-17",
            pdf_bytes: list[io.BytesIO] | None = None,
            image_bytes: list[io.BytesIO] | None = None,
            image_mime_type: str = "application/json",
            google_search=True,
            verbose=0,
            uid=None,
                    ) -> tuple | None:
        if not isinstance(generation_config, GenerateContentConfig):
            print("generation_config must be an instance of GenerationConfig")
            return None    
        try:
            contents = list(
                [
                    Part.from_text(text=prompt),
                ],
            )
            if google_search:
                generation_config.tools = [Tool(google_search=GoogleSearch())]
            if pdf_bytes:
                for pdf_byte in pdf_bytes:
                    contents.append(
                        Part.from_bytes(
                            data=pdf_byte.getvalue(), mime_type="application/pdf"
                        )
                    )
            if image_bytes:
                for image_byte in image_bytes:
                    contents.append(
                        Part.from_bytes(
                            data=image_byte.getvalue(), mime_type=image_mime_type
                        )
                    )
            response = self.client.models.generate_content(
                model=model_name, contents=contents, config=generation_config
            )
            input_tokens, output_tokens, total_tokens = self.get_token_used(
                response=response
            )
            return response.text, response

        except Exception as e:
            error_msg = f"Gemini API error: {e}"
            print(error_msg)
            return "", None

    def set_cost(self, inp_cost: float, out_cost: float):
        self.cost_per_million_input = inp_cost
        self.cost_per_million_output = out_cost

    def get_token_used(self, response, verbose=0):
        input_tokens = response.usage_metadata.prompt_token_count
        output_tokens = response.usage_metadata.candidates_token_count
        total_tokens = response.usage_metadata.total_token_count
        if verbose:
            print(f"Input Tokens: {input_tokens}")
            print(f"Output Tokens: {output_tokens}")
            print(f"Total Tokens Used: {total_tokens}")
        return input_tokens, output_tokens, total_tokens
    
    def token_count(
        self, input: list[Content], model_name: str = "gemini-2.5-flash-preview-04-17"
    ):
        return self.client.models.count_tokens(model=model_name, contents=input)

    def estimate_cost(self, input_tokens: int, output_tokens: int) -> float:
        # Check official Google Cloud pricing for current rates.
        input_cost = (input_tokens / 1_000_000) * self.cost_per_million_input
        output_cost = (output_tokens / 1_000_000) * self.cost_per_million_output
        total_cost = input_cost + output_cost
        return total_cost
