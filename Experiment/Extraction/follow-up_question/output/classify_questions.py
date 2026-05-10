import json
import glob
import os
import re
from pathlib import Path

# Paths
base_dir = r"c:\Users\Kittipob\Documents\GitHub\Garbage-Management-Simulation-Engine\Experiment\follow-up_question\output"
chunk_files = [os.path.join(base_dir, "v4.json")]
output_file = os.path.join(base_dir, "v4_classified.json")

def classify_question(q_list):
    classified_results = []
    
    # Simple rule-based classifier based on templates
    expert_patterns = [
        r"implicit factors", r"unstated assumptions", r"agreements",
        r"exactly did the", r"unstated safety", r"implicit mechanism",
        r"hidden conditions", r"implicit criteria", r"unstated logistical",
        r"unstated definitions", r"implicit spatial", r"unstated rules",
        r"underlying assumptions", r"specific thresholds", r"implicit conditions",
        r"operational constraints", r"workflow ensure", r"protocol or approval",
        r"exact threshold", r"specific resource limitations", r"specific activities",
        r"structural or policy", r"specialized handling", r"underlying assumptions",
        r"operational factors", r"implicit limitations", r"specific conditions",
        r"implicit communication", r"unstated aspects", r"budgetary constraints",
        r"contractual agreements", r"specific timelines", r"underlying behavioral",
        r"systemic or management", r"structural or workflow", r"specific ways"
    ]
    
    for q in q_list:
        q_lower = q.lower()
        category = "internet" # default fallback
        
        for pat in expert_patterns:
            if re.search(pat, q_lower):
                category = "expert"
                break
                
        # Additional heuristic: if it mentions specific local context
        if any(word in q_lower for word in ["bma", "units and offices", "mr. moss", "building pm", "maids", "students", "staff", "president", "committee"]):
            category = "expert"
            
        classified_results.append(category)
        
    return classified_results

def main():
    final_output = []
    
    for cfile in chunk_files:
        with open(cfile, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
        for item in data:
            source_text = item.get("source_text", "")
            generated_questions = item.get("generated_questions", [])
            
            # Classify questions
            categories = classify_question(generated_questions)
            
            # Build output objects
            for q, cat in zip(generated_questions, categories):
                final_output.append({
                    "source_text": source_text,
                    "question": q,
                    "category": cat
                })
                
    # Save to classified.json
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(final_output, f, ensure_ascii=False, indent=2)
        
    print(f"Successfully processed {len(chunk_files)} chunk files.")
    print(f"Generated {len(final_output)} classified questions.")
    print(f"Saved to {output_file}.")

if __name__ == "__main__":
    main()
