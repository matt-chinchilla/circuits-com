"""BOM tool wire models.

BomLineIn is deliberately identity-only: D7 says quantities, designators and
the file never leave the browser, so the schema gives them nowhere to land
(extra="forbid" turns an accidental qty into a 422, not a silent accept).
"""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class BomLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0)
    mpn: str | None = Field(default=None, max_length=200)
    value: str | None = Field(default=None, max_length=200)
    footprint: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=500)
    manufacturer: str | None = Field(default=None, max_length=200)


class BomMatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lines: list[BomLineIn] = Field(min_length=1, max_length=2000)


class BomMissIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0)
    # strip_whitespace BEFORE the length check: `min_length=1` accepts "   ",
    # and a blank keyword reaches DigiKeyProvider._search, which raises
    # ValueError — a class resolve_bom's per-miss guard does not catch, so it
    # would crash mid-stream after a 200 and after rows had already reached the
    # client. Nothing downstream can do anything useful with a blank query, so
    # it is refused at the edge where the answer is still a clean 422.
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
    mpn: str | None = Field(default=None, max_length=200)


class BomResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    misses: list[BomMissIn] = Field(min_length=1, max_length=50)


class BomShareCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payload: dict
