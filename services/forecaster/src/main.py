from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, field_validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("forecaster")

_model = None


def _load_model() -> None:
    """Load TimesFM once at startup. Logs error but does not raise — the service
    stays up and returns 503 on forecast requests until the model is available."""
    global _model
    try:
        import timesfm  # type: ignore[import]

        logger.info("Loading TimesFM 200M (pytorch/cpu) ...")
        _model = timesfm.TimesFm(
            hparams=timesfm.TimesFmHparams(
                backend="pytorch",
                horizon_len=128,
                context_len=512,
            ),
            checkpoint=timesfm.TimesFmCheckpoint(
                huggingface_repo_id="google/timesfm-1.0-200m-pytorch",
            ),
        )
        logger.info("TimesFM model loaded and ready")
    except Exception:
        logger.exception("Failed to load TimesFM model — /forecast will return 503")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_model()
    yield


app = FastAPI(title="TimesFM Forecaster", lifespan=lifespan)


class ForecastRequest(BaseModel):
    symbol: str
    prices: list[float]
    horizon_days: int = 7

    @field_validator("prices")
    @classmethod
    def prices_min_length(cls, v: list[float]) -> list[float]:
        if len(v) < 64:
            raise ValueError("prices must have at least 64 values")
        return v


class ForecastResponse(BaseModel):
    symbol: str
    point: float
    q10: float
    q90: float
    horizon_days: int


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model_loaded": _model is not None}


@app.post("/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest) -> ForecastResponse:
    if _model is None:
        raise HTTPException(status_code=503, detail="model not loaded")

    try:
        arr = np.array(req.prices, dtype=np.float32)

        point_fc, quantile_fc = _model.forecast(
            [arr],
            freq=[0],  # 0 = high-frequency / daily data
            prediction_length=req.horizon_days,
            quantile_levels=[0.1, 0.9],
        )

        # point_fc: (batch=1, horizon) — take the last step as the horizon estimate
        # quantile_fc: (batch=1, horizon, 2) — [q10, q90]
        point = float(point_fc[0, -1])
        q10 = float(quantile_fc[0, -1, 0])
        q90 = float(quantile_fc[0, -1, 1])

        logger.info(
            "forecast %s horizon=%d: point=%.2f q10=%.2f q90=%.2f",
            req.symbol, req.horizon_days, point, q10, q90,
        )

        return ForecastResponse(
            symbol=req.symbol,
            point=point,
            q10=q10,
            q90=q90,
            horizon_days=req.horizon_days,
        )

    except Exception as exc:
        logger.exception("inference error for %s", req.symbol)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
