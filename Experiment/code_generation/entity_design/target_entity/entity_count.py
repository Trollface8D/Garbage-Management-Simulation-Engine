import json
import csv
import re
from collections import Counter
from pathlib import Path
import matplotlib.pyplot as plt
from wordcloud import WordCloud
import pandas as pd
import spacy

# File paths
json_file = r"d:\works\[25-08-06] senior project\Framework_Simulation_Garbage\Experiment\causal_extraction\data_extract\output\transcript\V6\chunk\raw_gemini\response_raw_gemini_combined.json"
csv_output = r"d:\works\[25-08-06] senior project\Framework_Simulation_Garbage\Experiment\code_generation\entity_design\target_entity\word_frequency.csv"
wordcloud_output = r"d:\works\[25-08-06] senior project\Framework_Simulation_Garbage\Experiment\code_generation\entity_design\target_entity\wordcloud.png"

def standardize_text(text):
    """Standardize and clean text"""
    # Convert to lowercase
    text = text.lower()
    # Remove special characters but keep spaces
    text = re.sub(r'[^a-z0-9\s]', '', text)
    # Remove extra whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def extract_heads_tails(json_path):
    """Extract all heads and tails from JSON file"""
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    heads_tails = []
    
    for record in data:
        if 'extracted' in record and isinstance(record['extracted'], list):
            for item in record['extracted']:
                if isinstance(item, dict):
                    if 'head' in item:
                        heads_tails.append(('head', item['head']))
                    if 'tail' in item:
                        heads_tails.append(('tail', item['tail']))
    
    return heads_tails

def tokenize_and_count(texts):
    """Tokenize texts and count word frequencies using POS tagging"""
    # Load spacy model
    try:
        nlp = spacy.load('en_core_web_sm')
    except OSError:
        print("   ⚠ Downloading spacy model 'en_core_web_sm'...")
        import os
        os.system('python -m spacy download en_core_web_sm')
        nlp = spacy.load('en_core_web_sm')
    
    all_words = []
    pos_filtered_words = []
    
    # Keep only these POS tags (nouns and proper nouns)
    keep_pos = {'NOUN', 'PROPN'}  # NOUN and proper nouns
    # Drop these POS tags
    drop_pos = {'ADV', 'ADJ', 'ADP', 'AUX', 'CCONJ', 'DET', 'INTJ', 'NUM', 'PART', 'PRON', 'SCONJ', 'SYM', 'VERB', 'X'}
    
    for text in texts:
        standardized = standardize_text(text)
        words = standardized.split()
        # Filter out very short words
        words = [w for w in words if len(w) > 2]
        all_words.extend(words)
        
        # Process with spacy for POS tagging
        doc = nlp(standardized)
        for token in doc:
            if token.pos_ in keep_pos and len(token.text) > 2:
                pos_filtered_words.append(token.text)
    
    word_freq = Counter(pos_filtered_words)
    return word_freq, pos_filtered_words

def save_to_csv(word_freq, csv_path):
    """Save word frequency to CSV"""
    with open(csv_path, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['Word', 'Frequency'])
        for word, count in word_freq.most_common():
            writer.writerow([word, count])
    print(f"✓ CSV saved to: {csv_path}")

def create_wordcloud(word_freq, all_words, output_path):
    """Create and save word cloud from nouns only"""
    # Create word cloud from all words (nouns filtered)
    text = ' '.join(all_words)
    
    wordcloud = WordCloud(
        width=1200,
        height=600,
        background_color='white',
        colormap='viridis',
        max_words=100
    ).generate(text)
    
    # Create figure with larger size
    fig, ax = plt.subplots(figsize=(15, 8))
    ax.imshow(wordcloud, interpolation='bilinear')
    ax.axis('off')
    ax.set_title('Word Cloud from Extracted Heads and Tails (Nouns Only - POS Tagged)', fontsize=16, pad=20)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    print(f"✓ Word cloud saved to: {output_path}")
    plt.close()

def main():
    print("=" * 60)
    print("Extracting Heads and Tails from JSON with POS Filtering")
    print("=" * 60)
    
    # Extract heads and tails
    print("\n1. Extracting heads and tails from JSON...")
    heads_tails = extract_heads_tails(json_file)
    print(f"   Found {len(heads_tails)} items (heads + tails)")
    
    # Separate texts for processing
    texts = [item[1] for item in heads_tails]
    
    # Tokenize and count with POS tagging
    print("\n2. Standardizing and counting word frequencies (POS filtering)...")
    print("   Keeping: NOUN, PROPN (proper nouns)")
    print("   Dropping: ADV, ADJ, VERB, ADP, PRON, DET, etc.")
    word_freq, pos_filtered_words = tokenize_and_count(texts)
    print(f"   Total unique words (after POS filtering): {len(word_freq)}")
    print(f"   Total word tokens (after POS filtering): {len(pos_filtered_words)}")
    
    # Display top 20 words
    print("\n3. Top 20 most common nouns:")
    print("   " + "-" * 40)
    for i, (word, count) in enumerate(word_freq.most_common(20), 1):
        print(f"   {i:2d}. {word:20s} : {count:4d}")
    
    # Save to CSV
    print("\n4. Saving word frequency to CSV...")
    save_to_csv(word_freq, csv_output)
    
    # Create word cloud
    print("\n5. Creating word cloud...")
    create_wordcloud(word_freq, pos_filtered_words, wordcloud_output)
    
    print("\n" + "=" * 60)
    print("Process completed successfully!")
    print("=" * 60)
    print(f"\nOutput files:")
    print(f"  - CSV: {csv_output}")
    print(f"  - Word Cloud: {wordcloud_output}")

if __name__ == "__main__":
    main()
