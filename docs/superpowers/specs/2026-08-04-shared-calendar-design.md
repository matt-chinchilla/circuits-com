# Shared company calendar, inside the webmail

Date: 2026-08-04
Status: approved to build

## What this is

A basic shared calendar for the five people at Circuit Center, reachable from
inside the webmail rather than from a separate application. Meetings carry a
join URL. Reminders go out the day before and an hour before, by email and
optionally by SMS, and each of those can be switched off per event.

Explicitly NOT in scope: RSVP / accept-decline, recurring events, per-user
private calendars, external invitations, two-way sync with a phone's native
calendar app. Each is real work and none was asked for. The owner's words:
"the calendar is going to be pretty basic for now".

## Why it lives where it does

The calendar is a **Roundcube plugin backed by the existing FastAPI + Postgres
API**. That is a hybrid, and both halves are deliberate.

**Why a plugin and not the Kolab calendar.** The Kolab plugin's database driver
cannot do shared calendars at all: its `calendars` table is keyed to one
`user_id` with no ACL table and no sharee table, so it produces five private
calendars. Its CalDAV driver can share, but only by standing up Radicale,
resizing the box (896 MB of 916 MB committed today), building a derived arm64
Roundcube image to replace the upstream one, and maintaining shares as
hand-edited symlinks. Weeks of work and a permanent maintenance tax.

**Why a plugin is nevertheless cheap.** `docker-compose.webmail.yml` already
bind-mounts the skin read-only into the container, and lists plugins in the
`ROUNDCUBEMAIL_PLUGINS` env var. A plugin ships by exactly that mechanism: one
more `:ro` volume, one more name in that variable. A purpose-built plugin has
no composer dependencies, so the upstream image is untouched and Roundcube
patch releases keep arriving for free. This is the fact that changed the
recommendation — the earlier "weeks of work" applied to Kolab's dependency
tree, not to plugins as a category.

**Why the data is not in Roundcube's database.** Roundcube runs SQLite in the
`roundcube-data` volume, which is NOT covered by the mail box's backup story.
Events belong in Postgres on the web box, which is backed up nightly and
already has the auth, the migrations and the SES relay.

## Data

One table, migration **025** (head on disk is 024).

`calendar_events`
- `id` UUID pk
- `title` String(200) not null
- `starts_at` / `ends_at` TIMESTAMPTZ not null
- `all_day` Boolean not null default false
- `location` String(200) null
- `meeting_url` Text null
- `notes` Text null
- `remind_day_before` Boolean not null default true
- `remind_hour_before` Boolean not null default true
- `notify_email` Boolean not null default true
- `notify_sms` Boolean not null default false
- `created_by_id` UUID fk users.id null (ON DELETE SET NULL)
- `created_at` / `updated_at` TIMESTAMPTZ

**There is no owner column, and that is the design.** Shared is the default
state rather than something configured per event; a company of five does not
need per-user visibility, and adding it later is a migration, not a rewrite.

`calendar_reminder_sends` — the idempotency ledger
- `id` UUID pk
- `event_id` UUID fk calendar_events.id ON DELETE CASCADE
- `kind` String(16) — `day_before` | `hour_before`
- `channel` String(8) — `email` | `sms`
- `sent_at` TIMESTAMPTZ not null
- UNIQUE (`event_id`, `kind`, `channel`)

The unique constraint is the whole point: the reminder job is a cron that may
run late, twice, or overlap itself, and the database — not the job's own
bookkeeping — is what guarantees one send. A rescheduled event clears its rows
so its reminders fire again against the new time.

## API

`app/routes/calendar.py`, prefix `/api/calendar`.

- `GET    /events?from=&to=` — list in a window
- `POST   /events`
- `PATCH  /events/{id}`
- `DELETE /events/{id}`

All four depend on `get_current_user`, so the forced-password-change gate and
the existing auth model apply unchanged.

**The demo account is excluded fail-closed, for reads as well as writes.**
`is_demo_user` already makes demo read-only for mutations, which is not enough
here: the demo login is public and unauthenticated by design, so leaving reads
open would publish the company's meeting schedule to anyone who clicks "See
Demo". A dedicated dependency refuses demo on every calendar route.

`meeting_url` is validated server-side to http(s) via the same approach as
`validate_optional_image_url`, and rendered through a scheme allowlist. A
stored `javascript:` URL in a field that becomes an `href` is the exact
stored-XSS shape this repo has already been bitten by; both the write boundary
and the render site guard it.

### The plugin's door

The Roundcube plugin calls the API **server-side from PHP**, never from the
browser. It authenticates with a shared secret in a header, mirroring the
existing `MAIL_SYNC_SECRET` channel between these two boxes. This avoids CORS
entirely and means no credential is ever exposed to a webmail user's browser.

The secret lives in `/opt/circuits-com/.env` (API side) and
`/opt/circuits-mail/.env` (plugin side) and never in git. When it is unset the
plugin renders an explanatory empty state rather than failing obscurely.

## Reminders

`app/jobs/send_reminders.py`, invoked by cron on the API box:

    docker compose exec -T api python -m app.jobs.send_reminders < /dev/null

`-T` and the `/dev/null` redirect are both load-bearing — `docker compose exec`
consumes the stdin of a wrapping heredoc otherwise, which this repo has been
caught by before.

Every run: find events whose `starts_at` falls in the day-before or hour-before
window, skip any with a matching row in the ledger, send, record. Windows are
generous (a lookback, not an instant) so a missed cron tick still delivers.

- **Email** through `app/services/email.py`, the existing aiosmtplib → SES path.
- **SMS** through a new `app/services/sms.py` wrapping SNS publish to a topic.
  Entirely optional: when `SMS_TOPIC_ARN` is unset the service is inert and
  `notify_sms` silently does nothing. No new hard dependency on AWS creds for
  a calendar to work.

Cost note: SNS SMS is roughly $0.0065 per message in the US. Five people, two
reminders, a few meetings a week is cents per month. The reason it is off by
default is setup friction and the risk of a loop sending real money, not the
unit price.

## The plugin

`mail/roundcube-plugins/cccalendar/`

- `cccalendar.php` — registers the task, the actions, the API client
- `templates/calendar.html` — month grid
- `cccalendar.js` — day click, event dialog
- `skins/circuitcenter/cccalendar.css` — styled to D1 so it does not leak
  stock Elastic blue into a skin that just spent a day removing it

Wired by adding the mount to `docker-compose.webmail.yml` and `cccalendar` to
`ROUNDCUBEMAIL_PLUGINS`.

## Testing

pytest, alongside the existing ~710:
- migration contract (columns, the unique constraint, nullability)
- CRUD round-trip and window filtering
- auth: unauthenticated 401; **demo refused on read and write**
- `meeting_url` rejects `javascript:`, `data:`, and accepts http(s)
- reminder windows: fires in-window, not out; both kinds independently
- idempotency: a second run in the same window sends nothing
- toggles: `remind_*` and `notify_*` false suppress correctly
- SMS inert when unconfigured; no exception, no send
- compose passthrough guard for the new env vars, mirroring
  `test_compose_env_passthrough.py`

## Open, deliberately deferred

- Reminders go to the fixed mailbox roster, not per-event attendees. An
  attendees field is the obvious next step and is not needed to ship.
- No admin-SPA page. The owner wants this in the webmail; building a second
  UI would double the surface for no asked-for benefit.
