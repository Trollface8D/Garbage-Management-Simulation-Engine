from sentence_transformers import SentenceTransformer
import numpy as np
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score
import matplotlib.pyplot as plt
import seaborn as sns
import json
import os
import pandas as pd
import csv
from pathlib import Path
import sys
import time
from datetime import datetime
import logging
from tqdm import tqdm

# Logging setup: controlled by environment variable LOG_LEVEL (DEBUG, INFO, WARNING, ERROR)
log_level = os.getenv("LOG_LEVEL", "INFO").upper()
numeric_level = getattr(logging, log_level, logging.INFO)
logging.basicConfig(level=numeric_level, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Add these lines to fix the import ---
# Get the absolute path of the current script's directory
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.abspath(os.path.join(current_dir, "..", ".."))
# Add the project root to the sys.path
sys.path.append(project_root)
# --- End of fix ---

def cluster_and_visualize_embeddings(embeddings, texts, n_clusters=4, cluster_labels=None, random_state=42):
    """
    Clusters high-dimensional embedding vectors and visualizes them in a 2D plot.

    Args:
        embeddings (np.ndarray): A 2D numpy array of shape (n_samples, n_features)
                                 containing the embedding vectors.
        n_clusters (int): The number of clusters to form.
        random_state (int): Seed for reproducibility.
    """
    if not isinstance(embeddings, np.ndarray) or embeddings.ndim != 2:
        raise ValueError("Embeddings must be a 2D numpy array.")

    # --- 1. Dimensionality Reduction using PCA ---
    # Reduce the high-dimensional embeddings to 2 dimensions for visualization.
    pca = PCA(n_components=2, random_state=random_state)
    reduced_embeddings = pca.fit_transform(embeddings)
    logger.debug(f"Original dimensions: {embeddings.shape[1]}, Reduced dimensions: {reduced_embeddings.shape[1]}")

    # --- 2. Clustering using KMeans ---
    # Use provided cluster_labels if given, otherwise fit KMeans.
    if cluster_labels is None:
        kmeans = KMeans(n_clusters=n_clusters, random_state=random_state, n_init=10)
        cluster_labels = kmeans.fit_predict(embeddings)

    # --- 3. Visualization ---
    plt.style.use('seaborn-v0_8-whitegrid')
    plt.figure(figsize=(10, 8))

    # Create a scatter plot of the 2D reduced data, colored by cluster labels.
    scatter = plt.scatter(
        reduced_embeddings[:, 0],
        reduced_embeddings[:, 1],
        c=cluster_labels,
        cmap='viridis',  # A vibrant color map
        alpha=0.8,
        edgecolor='k',
        s=100  # Marker size
    )

    # --- 4. Add Text Annotations (The New Part) ---
    for i, txt in enumerate(texts):
        plt.annotate(
            txt,#[:10]+"...",
            (reduced_embeddings[i, 0], reduced_embeddings[i, 1]),
            textcoords="offset points", # how to position the text
            xytext=(0, 5),             # distance from text to points (x,y)
            ha='center',               # horizontal alignment
            fontsize=8                 # font size
        )

    # Add plot titles and labels
    plt.title('2D Visualization of Clustered Embeddings', fontsize=16)
    plt.xlabel('Principal Component 1', fontsize=12)
    plt.ylabel('Principal Component 2', fontsize=12)
    
    # Add a legend to identify clusters — build proxy handles from actual cluster assignments
    try:
        unique_labels = np.unique(cluster_labels)
    except Exception:
        unique_labels = np.arange(n_clusters)
    unique_labels = np.sort(unique_labels)

    # Get colormap and normalization used by the scatter
    cmap = getattr(scatter, 'cmap', plt.get_cmap('viridis'))
    norm = getattr(scatter, 'norm', plt.Normalize(vmin=unique_labels.min(), vmax=unique_labels.max() if unique_labels.size>0 else 1))

    # Create proxy artists so legend handles match labels
    from matplotlib.lines import Line2D
    handles = []
    labels = []
    # Try to extract the actual colors used by the scatter for each point
    facecolors = None
    try:
        facecolors = scatter.get_facecolors()
    except Exception:
        facecolors = None

    for lab in unique_labels:
        # prefer the actual plotted color for a representative point in the cluster
        color = None
        if facecolors is not None and facecolors.shape[0] == len(cluster_labels):
            idxs = np.where(cluster_labels == lab)[0]
            if idxs.size > 0:
                color = facecolors[int(idxs[0])]
        if color is None:
            color = cmap(norm(lab))

        handles.append(Line2D([0], [0], marker='o', color='w', markerfacecolor=color, markersize=10, markeredgecolor='k'))
        labels.append(f'Cluster {int(lab)}')

    if handles:
        plt.legend(handles=handles, labels=labels, title="Clusters")

    plt.grid(True)
    plt.show()


def select_best_kmeans(embeddings, min_k=2, max_k=10, random_state=42):
    """
    Determine best number of clusters for KMeans using silhouette score.

    Args:
        embeddings (np.ndarray): 2D array (n_samples, n_features).
        min_k (int): Minimum number of clusters to try (>=2).
        max_k (int): Maximum number of clusters to try.
        random_state (int): Seed for reproducible KMeans runs.

    Returns:
        tuple: (best_k, best_kmeans_model)
    """
    if not isinstance(embeddings, np.ndarray) or embeddings.ndim != 2:
        raise ValueError("Embeddings must be a 2D numpy array.")

    n_samples = embeddings.shape[0]
    # Can't have more clusters than samples-1, and at least 2 samples required
    if n_samples < 2:
        return 1, None

    max_k = min(max_k, n_samples - 1)
    best_score = -1.0
    best_k = None
    best_model = None
    best_labels = None

    for k in range(max(2, min_k), max(2, max_k) + 1):
        start = time.time()
        kmeans = KMeans(n_clusters=k, random_state=random_state, n_init=10)
        labels = kmeans.fit_predict(embeddings)
        end = time.time()
        logger.info(f"time consumed for k={k} : {end-start}")
        # silhouette_score requires at least 2 clusters and less than n_samples
        try:
            score = silhouette_score(embeddings, labels)
        except Exception:
            score = -1.0

        if score > best_score:
            logger.info(f"got new best fit at k: {k} score:{score}")
            best_score = score
            best_k = k
            best_model = kmeans
            best_labels = labels

    # Fallback: if silhouette never improved, choose 2
    if best_k is None:
        best_k = 2
        best_model = KMeans(n_clusters=best_k, random_state=random_state, n_init=10).fit(embeddings)

    return best_k, best_model, best_labels

if __name__ == "__main__":
    # path = "./output/exp1"
    dir_path = "./output/exp2/"
    
    # --- Data Loading Section ---
    path = input("target directory from root (causal extract folder): ")
    if path == "":
        path = "./output/exp1"
    directory_path = Path(path)
    logger.info(f"Listing files in : {directory_path}")
    json_files_generator = directory_path.glob("*.json")
    filelist = list(json_files_generator)
    logger.info(f"Discovered JSON files: {filelist}")
    if len(filelist) == 0:
        logger.info(f"directory empty cloing app...")
        exit()
    test = int(input("file index: "))
    selected_file = filelist[test]
    raw_data = pd.read_json(selected_file)
    named_entities = []
    context_add = int(input("using context? (0/1): "))
    if context_add == 1:
        named_entities = []
        # handle decompose comma seperate
        for i, record in raw_data.iterrows():
            for j in record[4].split(","):
                named_entities.append(f"context: {record[2]} named entity: {j.strip()}")
    else:
        # handle decompose comma seperate
        for record in raw_data.iloc[:,-2].to_list():
            for i in record.split(","):
                clean = i.strip()
                # drop duplicate 
                if clean not in named_entities:
                    named_entities.append(clean)
    logging.info("named entity cleaned:" ,named_entities)

    # --- Model Loading and Embedding ---
    start_model = time.time()
    model = SentenceTransformer("./models/gemma3")
    end_model = time.time()
    logger.info(f"model load time: {end_model-start_model} seconds")
    
    prompt_template = "task: clustering | query: {content}"
    document_embeddings = model.encode_document([prompt_template.format(content=d) for d in named_entities])
    logger.debug(f"document_embeddings.shape: {document_embeddings.shape}")
    
    #get best fit n cluster
    # --- Clustering and Visualization ---
    start_cluster = time.time()
    # choose best k with silhouette score
    best_k, best_model, prediction = select_best_kmeans(document_embeddings, min_k=2, max_k=min(30, document_embeddings.shape[0]-1))
    end_n_search = time.time()
    # visualize using the labels from the selected model
    show_text = named_entities
    if context_add:
        show_text = [i.split("named entity:")[-1] for i in named_entities]
    cluster_and_visualize_embeddings(document_embeddings, show_text, n_clusters=best_k, cluster_labels=prediction)
    end_cluster = time.time()
    
    # --- Save Results ---
    if not Path(dir_path).is_dir():
        os.mkdir(dir_path)
    
    current_time = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    output_path = f"{dir_path}vec_embedding_{current_time}_{selected_file.name}"
    
    # Save clustering results as JSON
    results = {
        "named_entities": named_entities,
        "cluster": prediction.tolist(),
        "model_load_time": end_model - start_model,
        "optimal_n_search_time":end_n_search - start_cluster,
        "clustering_time": end_cluster - start_cluster,
        "embedding": document_embeddings.tolist()
    }
    
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    
    # --- Save Log ---
    log_file_path = "output/nec_log.csv"
    if not os.path.isfile(log_file_path):
        with open(log_file_path, "w", newline='') as f:
            writer = csv.writer(f)
            writer.writerow(["method",
                             "output path",
                            "input path",
                            "prompt template",
                            "inference time",
                            "input tokens",
                            "output tokens",
                            "reasoning tokens"])

    with open(log_file_path, "a+", newline='') as f:
        writer = csv.writer(f)
        writer.writerow([
            "vector_embedding_clustering",
            output_path,
            path + selected_file.name,
            "",
            end_cluster - start_cluster,
        ])
    
    logger.info("wrote log...")