from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class MessageResponse(BaseModel):
    """Response shape mirrors `frontend/src/admin/types/messages.ts:Message`.

    The discriminated `type` ('contact'|'join'|'keyword'|'reply') drives the
    shape of the nested `payload` dict — kept as `dict` here so a single
    response model serves all four message types end-to-end.
    """

    id: str
    type: str
    status: str
    seq: int
    created_at: datetime
    read_at: datetime | None = None
    responded_at: datetime | None = None
    assigned_to: str | None = None
    spam_score: float | None = None
    last_reply_body: str | None = None
    payload: dict

    model_config = ConfigDict(from_attributes=True)


class MessageUpdate(BaseModel):
    status: str | None = None
    assigned_to: str | None = None
    last_reply_body: str | None = None


class MessageDeleteResponse(BaseModel):
    """Single-delete acknowledgement — `{"status": "ok"}`."""

    status: str


class MessageBulkDeleteRequest(BaseModel):
    """Ids the admin selected in the inbox.

    A selection list is inherently STALE (someone else may have deleted a row
    between the render and the click), so unknown ids are reported back as
    `missing`, never raised as an error.
    """

    ids: list[str] = Field(default_factory=list)


class MessageBulkDeleteResponse(BaseModel):
    """`deleted` = rows actually removed, `missing` = ids that were not found.

    They sum to the number of DISTINCT ids in the request.
    """

    deleted: int
    missing: int
