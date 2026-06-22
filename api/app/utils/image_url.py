import re
from urllib.parse import urlparse

MAX_IMAGE_URL_LEN = (
    200_000  # ~64KB client cap × base64 headroom; blocks multi-MB abuse via direct API
)
_RASTER_DATA_IMAGE = re.compile(r"^data:image/(png|jpe?g|webp|gif|avif);base64,", re.IGNORECASE)


def validate_optional_image_url(value: str | None) -> str | None:
    """Pydantic validator: allow None, http(s) URLs, and raster data:image URLs;
    reject javascript:/data:text-html/data:image-svg+xml and over-long values.
    Mirrors the frontend @shared/utils/url safeImageUrl allowlist (defense-in-depth
    so a future read site that forgets safeImageUrl can't leak a stored hostile value)."""
    if value is None:
        return value
    if len(value) > MAX_IMAGE_URL_LEN:
        raise ValueError(f"image URL too long (max {MAX_IMAGE_URL_LEN} chars)")
    if _RASTER_DATA_IMAGE.match(value):
        return value
    parsed = urlparse(value)
    if parsed.scheme in ("http", "https"):
        return value
    raise ValueError("must be an http(s) URL or a raster data:image URL")
