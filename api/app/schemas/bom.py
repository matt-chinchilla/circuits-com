"""BOM tool wire models.

BomLineIn is deliberately identity-only: D7 says quantities, designators and
the file never leave the browser, so the schema gives them nowhere to land
(extra="forbid" turns an accidental qty into a 422, not a silent accept).
"""

from pydantic import BaseModel, ConfigDict, Field


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
    query: str = Field(min_length=1, max_length=300)
    mpn: str | None = Field(default=None, max_length=200)


class BomResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    misses: list[BomMissIn] = Field(min_length=1, max_length=50)


class BomShareCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payload: dict
