from datetime import datetime

from pydantic import BaseModel, ConfigDict


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
