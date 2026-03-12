"""
Script to combine all Python files in the current directory into 9_snapshot.py
"""
import os
import re
from pathlib import Path

def combine_python_files():
    # Get the current directory
    current_dir = Path(__file__).parent
    
    # Output file
    output_file = current_dir / "snapshot.py"
    
    # Get all Python files except combine_files.py and 9_snapshot.py
    python_files = sorted([
        f for f in current_dir.glob("*.py")
        if f.name not in ["combine_files.py", "snapshot.py"]
    ])
    
    if not python_files:
        print("No Python files found to combine!")
        return
    
    # Collect all content
    all_content = []
    
    for file_path in python_files:
        print(f"Processing {file_path.name}...")
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Add content with file separator
        all_content.append(f"\n# ===== {file_path.name} =====\n")
        all_content.append(content)
    
    # Write to output file
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(all_content))
    
    print(f"\nSuccessfully combined {len(python_files)} files into {output_file.name}")

if __name__ == "__main__":
    combine_python_files()
