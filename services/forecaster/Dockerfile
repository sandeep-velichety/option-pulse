FROM python:3.11-slim

# Layer 1: PyTorch CPU-only wheel (~750MB) — heaviest dep, changes least
RUN pip install --no-cache-dir     torch==2.2.0     --index-url https://download.pytorch.org/whl/cpu

# Layer 2: TimesFM + serving deps
RUN pip install --no-cache-dir     "timesfm[torch]==1.2.7"     "fastapi==0.111.0"     "uvicorn[standard]==0.29.0"     "numpy>=1.24.0,<2.0.0"

# Layer 3: bake model weights into image so cold start doesn't download 800MB
RUN python -c "import timesfm; timesfm.TimesFm(     hparams=timesfm.TimesFmHparams(backend='pytorch', horizon_len=128, context_len=512),     checkpoint=timesfm.TimesFmCheckpoint(huggingface_repo_id='google/timesfm-1.0-200m-pytorch'), ); print('weights baked ok') "

# Layer 4: app source (changes most — keep last for cache efficiency)
WORKDIR /app
COPY src/ ./src/

EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
