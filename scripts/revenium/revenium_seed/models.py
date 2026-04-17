"""Pydantic models for Revenium seed payloads.

Demo-only data shapes — no PII, no real customer info. Org names are public
distributor brands used purely as recognizable labels for the CTO demo.
"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class CustomerOrg(BaseModel):
    """A circuits.com customer organization in Revenium (demo placeholder)."""
    slug: str
    name: str
    website: str
    contact_email: str
    description: str = ""


class Product(BaseModel):
    """An AI product circuits.com meters against Revenium."""
    key: str
    name: str
    description: str
    model: str
    provider: str = "anthropic"
    input_tokens_range: tuple[int, int]
    output_tokens_range: tuple[int, int]
    input_cost_per_mtok_usd: float
    output_cost_per_mtok_usd: float
    peak_daily_volume: int


class CompletionEvent(BaseModel):
    """One backdated AI completion destined for meter_ai_completion."""
    transaction_id: str
    trace_id: str
    organization_name: str
    product_name: str
    product_key: str
    model: str
    provider: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    request_time: datetime
    response_time: datetime
    duration_ms: int
    subscriber_email: str | None = None
    is_anomaly: bool = False


class ProbeAttempt(BaseModel):
    days_back: int
    status: str
    http_code: int | None = None
    error: str | None = None


class ProbeResult(BaseModel):
    """Result of the canary timestamp-backdating probe."""
    probed_at: datetime
    max_backdate_days_accepted: int
    attempts: list[ProbeAttempt] = Field(default_factory=list)
