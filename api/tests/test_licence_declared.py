"""The programme is GPL-3.0-or-later (owner, 2026-09-12). A public repo with no
LICENSE file is all-rights-reserved by default, which contradicts that; this
guard keeps the three declarations agreeing."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_licence_file_is_gpl3_or_later():
    text = (ROOT / "LICENSE").read_text(encoding="utf-8")
    assert text.lstrip().startswith("GNU GENERAL PUBLIC LICENSE")
    assert "Version 3, 29 June 2007" in text


def test_frontend_declares_the_same_licence():
    pkg = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    assert pkg["license"] == "GPL-3.0-or-later"


def test_api_declares_the_same_licence():
    toml = (ROOT / "api" / "pyproject.toml").read_text(encoding="utf-8")
    assert re.search(r'^license\s*=\s*\{\s*text\s*=\s*"GPL-3.0-or-later"\s*\}', toml, re.M)
