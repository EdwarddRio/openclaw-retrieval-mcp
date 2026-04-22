"""Embedding model wrapper with singleton pattern."""

import contextlib
import io
import os
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")

_model = None
_model_unavailable = False


def get_model():
    """Return the singleton embedding model, loading lazily on first call."""
    global _model, _model_unavailable
    if _model is not None:
        return _model
    if _model_unavailable:
        return None
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            _model = SentenceTransformer(MODEL_NAME)
        return _model
    except Exception as exc:
        _model_unavailable = True
        raise RuntimeError(f"Failed to load embedding model {MODEL_NAME}: {exc}")


def encode_texts(texts):
    """Encode a list of texts into embeddings.

    Args:
        texts: List of strings to encode.

    Returns:
        List of embedding vectors (each is a list of floats).
    """
    model = get_model()
    if model is None:
        raise RuntimeError("Embedding model is not available")
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        embeddings = model.encode(texts, show_progress_bar=False)
    return embeddings.tolist() if hasattr(embeddings, "tolist") else embeddings


def get_model_info():
    """Return model metadata."""
    model = get_model()
    if model is None:
        return None
    return {
        "model_name": MODEL_NAME,
        "dimension": model.get_sentence_embedding_dimension(),
    }
