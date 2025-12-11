import json
import os
import pandas as pd
import csv
from pathlib import Path
import sys # <-- Add this
import time
from datetime import datetime
from google.api_core import exceptions as google_exceptions
# --- Add these lines to fix the import ---
# Get the absolute path of the current script's directory
current_dir = os.path.dirname(os.path.abspath(__file__))
# Go up two levels to the project root (D:\)
project_root = os.path.abspath(os.path.join(current_dir, "..", ".."))
# Add the project root to the sys.path
sys.path.append(project_root)
# --- End of fix ---

from utils.prompt import out_as_json
from utils.gemini import GeminiClient
from config import API_KEY
with open("prompt.json") as f:
    prompts = json.load(f)
prompt_template = prompts["listwise_clustering"]
client = GeminiClient(key=API_KEY)
path = "./output/exp1"
dir_path = "./output/exp2/"


if __name__ == "__main__":
    path = input("target directory from root (causal extract folder): ")
    if path == "":
        path = "./output/exp1"
    directory_path = Path(path)  # Create a Path object for the current directory
    

    # The .glob() method finds all files matching the pattern
    # The '*' is a wildcard for "anything"
    json_files_generator = directory_path.glob("*.json")

    # Convert the generator to a list to see the results
    filelist = list(json_files_generator)
    print(filelist)
    test = int(input("file index: "))
    selected_file =  filelist[test]
    raw_data = pd.read_json(selected_file)
    context_add = int(input("using context? (0/1): "))
    if context_add == 1:
        named_entities = ""
        # handle decompose comma seperate
        for i, record in raw_data.iterrows():
            named_entities+=f"context: {record[2]} named entity: {record[4]}\n"
    else:
        named_entities = []
        for record in raw_data.iloc[:,-2].to_list():
            for i in record.split(","):
                clean = i.strip()
                # drop duplicate 
                if clean not in named_entities:
                    named_entities.append(clean)
    print("named entity cleaned:" ,named_entities)
    request = prompt_template.format(named_entities)
    print(f"request: {request}")
    try:
        start = time.time()
        output, response = client.generate(request, out_as_json, model_name = "gemini-2.5-pro", google_search=False)
        end = time.time()
        print(f"\noutput: {response}")
    except google_exceptions.InternalServerError as e:
        # This specifically catches 500-level errors (what you were checking for)
        print(f"A 500-level server error occurred: {e}")
        # You could add retry logic here

    except google_exceptions.ResourceExhausted as e:
        # This catches Rate Limiting errors (HTTP 429)
        print(f"Rate limit exceeded. Please wait and try again. {e}")

    except google_exceptions.GoogleAPICallError as e:
        # This is a more general catch-all for other Google API errors
        print(f"A Google API error occurred: {e}")

    except Exception as e:
        # This catches any other unexpected Python errors
        print(f"An unexpected error occurred: {e}")
    if response == None:
         exit()
    # save output as json file at (./output/exp2)
    if not Path(dir_path).is_dir():
        # path not exist -> create
        os.mkdir(dir_path)
        # we can use dir_path.mkdir as alternative
    current_time = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    output_path = f"{dir_path}listwise_{current_time}_{selected_file.name}"
    with open(output_path, "w") as f:
        f.write(str(response))
    # save log at nec_log.csv as header: output_path, input_path, prompt_template, inference time
    log_file_path = "output/nec_log.csv"
    # check if the file exist if not we write header file
    if not os.path.isfile(log_file_path):
         with open(log_file_path, "w", newline='') as f:
             writer = csv.writer(f)
             writer.writerow(["method","output path", "input path", "prompt template", "inference time", "input tokens", "output tokens", "reasoning tokens"])
    with open(log_file_path, "a+", newline='') as f:
             writer = csv.writer(f)
             writer.writerow([
                "Listwise",
                output_path,
                path+selected_file.name,
                prompt_template,
                end-start,
                response.usage_metadata.prompt_token_count ,
                response.usage_metadata.candidates_token_count,
                response.usage_metadata.thoughts_token_count
                        ])
    print("wrote log...")
    

def manual_input():
    test = input("named entity list: ")
    request = prompt_template.format(test)
    print(f"request: {request}")
    output, response = client.generate(prompt_template.format(test), out_as_json, model_name = "gemini-2.5-pro", google_search=False)
    print(f"\noutput: {output}")
    