import os
import torch
from registry import ModelRegistry

class GraphVecDB:
    def __init__(self, model_name=None):
        self.model_name = model_name
        self.metadata = [] 
        self.ids = [] 
        self.vector = None

    def _get_model(self):
        return ModelRegistry.get_model(self.model_name)

    def add_entity(self, entity_id, entity_metadata):
        self.ids.append(entity_id)
        self.metadata.append(entity_metadata)
        # Shared singleton call
        embedding = self._get_model().encode([entity_metadata], normalize_embeddings=True, convert_to_tensor=True)
        self.vector = embedding if self.vector is None else torch.vstack([self.vector, embedding])

    def search(self, query, top_k=5):
        if not self.ids: return []
        query_vec = self._get_model().encode([query], normalize_embeddings=True, convert_to_tensor=True)
        similarities = torch.nn.functional.cosine_similarity(query_vec, self.vector, dim=-1)
        
        vals, indices = torch.topk(similarities, k=min(top_k, len(self.ids)))
        return [{"id": self.ids[i], "score": vals[i].item(), "metadata": self.metadata[i]} for i in indices]

    def save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        torch.save({"metadata": self.metadata, "ids": self.ids, "vector": self.vector}, path)

    def load(self, path):
        if os.path.exists(path):
            state = torch.load(path, weights_only=False)
            self.metadata, self.ids, self.vector = state["metadata"], state["ids"], state["vector"]