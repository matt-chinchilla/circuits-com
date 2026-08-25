"""Admin image proxy — GET /api/admin/image-proxy?url=...

Fetches a remote logo SERVER-side and streams the bytes back, so the admin
browser can run the crop + brand-color-extraction flow on a pasted image URL.
Without this, a cross-origin <img> taints the canvas and both
`canvas.toDataURL()` (the crop export) and `getImageData()` (palette
extraction) throw — which is why the paste-URL path historically skipped the
cropper entirely.

Auth-gated like the rest of /admin/* via Depends(get_current_user).

SSRF guards: http(s) only, every redirect hop re-validated, hostnames that
resolve to private / loopback / link-local / reserved ranges rejected (blocks
169.254.169.254 metadata, localhost, RFC1918). DNS is resolved once per hop —
a rebinding TOCTOU between check and fetch is out of scope for this app.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

import httpx
from anyio import to_thread
from fastapi import APIRouter, Depends, HTTPException, Response

from app.models.user import User
from app.services.auth_service import get_current_user, require_console_user

router = APIRouter(
    prefix="/api/admin",
    tags=["admin-media"],
    # D16: the console pages are shared with activated customers, so the
    # customer/staff wall sits on the router. It COMPOSES with the per-route
    # get_current_user gates — it does not replace them.
    dependencies=[Depends(require_console_user)],
)

_MAX_BYTES = 8 * 1024 * 1024  # matches "reasonable logo" — cropper downscales to 256px anyway
_MAX_REDIRECTS = 3
_TIMEOUT = httpx.Timeout(8.0)


async def _assert_public_http_url(url: str) -> None:
    """422 unless url is http(s) AND its host resolves only to public addresses.

    The lookup runs in a worker thread: ``socket.getaddrinfo`` is BLOCKING and
    this executes on the request's event loop, so an unresponsive resolver
    (seconds, once per redirect hop) would otherwise freeze every concurrent
    request on the worker — including public ``/api/*`` traffic.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(422, "The image URL must start with http:// or https://.")
    try:
        infos = await to_thread.run_sync(socket.getaddrinfo, parsed.hostname, None)
    except socket.gaierror:
        raise HTTPException(422, "Could not resolve that image host.") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise HTTPException(422, "That image host is not reachable from here.")


async def _fetch_image(
    url: str, transport: httpx.AsyncBaseTransport | None = None
) -> tuple[bytes, str]:
    """Fetch url (following ≤3 redirects, re-validating each hop) and return
    (bytes, content_type). Raises HTTPException(422) on anything unusable.

    ``transport`` is the test seam — None is httpx's real network transport;
    tests pass an ``httpx.MockTransport`` so the guards below (per-hop SSRF
    re-validation, size cap, content-type filter, redirect cap) run for REAL
    against scripted responses instead of being monkeypatched away.
    """
    # Some CDNs (e.g. Wikimedia) refuse UA-less requests — identify honestly.
    headers = {
        "User-Agent": "CircuitCenterAdmin/1.0 (+https://circuitcenter.ai; logo cropper)",
        "Accept": "image/*",
    }
    async with httpx.AsyncClient(
        timeout=_TIMEOUT, follow_redirects=False, headers=headers, transport=transport
    ) as client:
        # Connection refused / DNS blips / timeouts / a malformed redirect target
        # are the remote host's problem, not ours — surface them as the same 422
        # the other unusable-image paths return instead of a 500.
        try:
            for _ in range(_MAX_REDIRECTS + 1):
                await _assert_public_http_url(url)
                async with client.stream("GET", url) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        location = resp.headers.get("location")
                        if not location:
                            raise HTTPException(422, "The image host sent a broken redirect.")
                        url = str(httpx.URL(url).join(location))
                        continue
                    if resp.status_code != 200:
                        raise HTTPException(
                            422, f"The image host answered HTTP {resp.status_code}."
                        )
                    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                    # Raster images only — svg goes through <img> fine but canvas
                    # export of it is flaky, and svg can smuggle scripts elsewhere.
                    if not ctype.startswith("image/") or "svg" in ctype:
                        raise HTTPException(422, "That URL did not return a raster image.")
                    buf = bytearray()
                    async for chunk in resp.aiter_bytes():
                        buf.extend(chunk)
                        if len(buf) > _MAX_BYTES:
                            raise HTTPException(422, "That image is larger than 8 MB.")
                    return bytes(buf), ctype
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise HTTPException(422, "Could not fetch that image.") from exc
    raise HTTPException(422, "Too many redirects from the image host.")


@router.get("/image-proxy")
async def image_proxy(
    url: str,
    current_user: User = Depends(get_current_user),
) -> Response:
    data, ctype = await _fetch_image(url)
    return Response(
        content=data,
        media_type=ctype,
        headers={
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
        },
    )
