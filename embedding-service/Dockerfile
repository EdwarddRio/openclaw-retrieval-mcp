FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY app.py .
COPY model.py .

# Pre-download model
ENV EMBEDDING_MODEL=BAAI/bge-small-zh-v1.5

EXPOSE 8902

CMD ["python", "app.py"]
