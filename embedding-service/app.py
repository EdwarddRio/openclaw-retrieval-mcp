"""Lightweight HTTP service for text embedding generation."""

import os
from flask import Flask, request, jsonify

from model import encode_texts, get_model, get_model_info

app = Flask(__name__)

EMBEDDING_PORT = int(os.environ.get("EMBEDDING_PORT", "8902"))
MAX_BATCH_SIZE = int(os.environ.get("MAX_BATCH_SIZE", "500"))


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint."""
    try:
        info = get_model_info()
        if info is None:
            return jsonify({"status": "unhealthy", "model_loaded": False, "model_name": os.environ.get("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")}), 503
        return jsonify({
            "status": "healthy",
            "model_loaded": True,
            "model_name": info["model_name"],
            "dimension": info["dimension"],
        })
    except Exception as exc:
        return jsonify({"status": "unhealthy", "model_loaded": False, "error": str(exc)}), 503


@app.route("/embed", methods=["POST"])
def embed():
    """Encode a batch of texts into embeddings.

    Request body: {"texts": ["text1", "text2", ...], "model": "optional-model-name"}
    Response: {"embeddings": [[...], [...]], "model": "model-name", "dimension": 512}
    """
    data = request.get_json(force=True, silent=True) or {}
    texts = data.get("texts")

    if not texts:
        return jsonify({"error": "Missing 'texts' field"}), 400
    if not isinstance(texts, list):
        return jsonify({"error": "'texts' must be a list"}), 400
    if len(texts) > MAX_BATCH_SIZE:
        return jsonify({"error": f"Batch size exceeds maximum of {MAX_BATCH_SIZE}"}), 429

    try:
        embeddings = encode_texts(texts)
        info = get_model_info()
        return jsonify({
            "embeddings": embeddings,
            "model": info["model_name"],
            "dimension": info["dimension"],
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    # Pre-load model on startup
    try:
        get_model()
        print(f"Embedding service ready on port {EMBEDDING_PORT}")
    except Exception as exc:
        print(f"Warning: Model failed to load: {exc}")
    app.run(host="0.0.0.0", port=EMBEDDING_PORT, threaded=True)
