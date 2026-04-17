"""Canary probe: tests how far back Revenium accepts a backdated completion.

Runs one POST per offset in [7, 30, 60, 90] days. Stops escalating on first
rejection. Writes the verdict to probe_result.json so seed.py can read it
without re-probing on every invocation.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from revenium_metering import APIError

from .client import RevClient, ReveniumSeedError
from .models import ProbeAttempt, ProbeResult

PROBE_OFFSETS = [7, 30, 60, 90]
RESULT_PATH = Path(__file__).resolve().parent.parent / "probe_result.json"


async def _one_probe(client: RevClient, days_back: int) -> ProbeAttempt:
    now = datetime.now(tz=timezone.utc)
    request_time = now - timedelta(days=days_back)
    response_time = request_time + timedelta(milliseconds=300)
    tx_id = f"probe-{days_back}d-{uuid.uuid4().hex[:8]}"
    try:
        await client.meter_completion(
            completion_start_time=request_time.isoformat(),
            cost_type="AI",
            input_token_count=100,
            is_streamed=False,
            model="claude-haiku-4-5-20251001",
            output_token_count=50,
            provider="anthropic",
            request_duration=300,
            request_time=request_time.isoformat(),
            response_time=response_time.isoformat(),
            stop_reason="END",
            total_token_count=150,
            transaction_id=tx_id,
            trace_id=f"probe-trace-{uuid.uuid4().hex[:8]}",
            task_type="probe",
            agent="revenium-seed-probe",
        )
        return ProbeAttempt(days_back=days_back, status="accepted", http_code=200)
    except APIError as e:
        return ProbeAttempt(
            days_back=days_back,
            status="rejected",
            http_code=getattr(e, "status_code", None),
            error=str(e)[:300],
        )
    except (ReveniumSeedError, httpx.HTTPError) as e:
        # httpx.HTTPError covers DNS/connect/TLS/timeout errors that the SDK
        # doesn't wrap. Without this the probe crashes on transient network
        # blips instead of recording a rejected attempt.
        return ProbeAttempt(
            days_back=days_back, status="rejected", error=str(e)[:300]
        )


async def run_probe() -> ProbeResult:
    async with RevClient.from_env() as client:
        attempts: list[ProbeAttempt] = []
        max_accepted = 0
        for days in PROBE_OFFSETS:
            print(f"probing {days:>3}d backdated ...", end=" ", flush=True)
            attempt = await _one_probe(client, days)
            attempts.append(attempt)
            if attempt.status == "accepted":
                max_accepted = days
                print("OK")
            else:
                snippet = (attempt.error or "")[:140].replace("\n", " ")
                print(f"REJECTED (http {attempt.http_code}): {snippet}")
                break
        return ProbeResult(
            probed_at=datetime.now(tz=timezone.utc),
            max_backdate_days_accepted=max_accepted,
            attempts=attempts,
        )


def save_result(result: ProbeResult) -> None:
    RESULT_PATH.write_text(result.model_dump_json(indent=2))
    print(f"\nmax backdate accepted: {result.max_backdate_days_accepted}d")
    print(f"written to: {RESULT_PATH}")


async def main() -> None:
    result = await run_probe()
    save_result(result)


if __name__ == "__main__":
    asyncio.run(main())
