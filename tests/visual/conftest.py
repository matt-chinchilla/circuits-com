import pytest
from playwright.sync_api import Page


LIVE_URL = "http://localhost"

THEME_PARAMS = [
    ("base", ""),             # no query = base
    ("steel", "?nav=A"),
    ("schematic", "?nav=B"),
    ("pcb", "?nav=C"),
]


@pytest.fixture
def live_server_url() -> str:
    """Root URL of the docker-compose stack. Assumes `docker compose up -d` has been run."""
    return LIVE_URL


@pytest.fixture(params=THEME_PARAMS, ids=[p[0] for p in THEME_PARAMS])
def theme_url(request, live_server_url: str) -> tuple[str, str]:
    """Yields (theme_name, full_url) for each of the 4 themes."""
    name, query = request.param
    return name, f"{live_server_url}/{query}"


def wait_for_draw_animation_end(page: Page, timeout: int = 7000) -> float:
    """Wait for the 6s draw-circuit animation to finish on the last trace path.
    Returns the measured duration in milliseconds.
    """
    return page.evaluate(
        """
        () => new Promise((resolve) => {
            const start = performance.now();
            const traces = document.querySelectorAll('[class*="trace"]');
            if (traces.length === 0) { resolve(0); return; }
            let remaining = traces.length;
            const done = () => {
                remaining -= 1;
                if (remaining === 0) resolve(performance.now() - start);
            };
            traces.forEach(t => t.addEventListener('animationend', done, { once: true }));
            setTimeout(() => resolve(performance.now() - start), arguments[0] ?? 7000);
        })
        """,
        timeout,
    )
