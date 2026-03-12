import json

with open(r"d:\.HOMEWORK\KMUTT\Year4\Senior_project\github\Framework_Simulation_Garbage\Experiment\causal_extraction\data_extract\output\transcript\V6\chunk\raw_gemini\response_raw_gemini_combined.json", "r", encoding="utf-8") as f:
    data = json.load(f)

print(f"Total records: {len(data)}")

total_extracted = sum(len(record.get("extracted", [])) for record in data)
print(f"Total extracted items: {total_extracted}")