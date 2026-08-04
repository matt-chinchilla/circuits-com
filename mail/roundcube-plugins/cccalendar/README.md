# cccalendar — the shared company calendar, inside the webmail

A month grid for the five people at Circuit Center, reachable from the task
rail in Roundcube rather than from a separate application. Meetings carry a
join link. Reminders are the API's job, not this plugin's; the four toggles
here are what turn them on and off per event.

Design rationale, the data model, and what is deliberately out of scope live in
[`docs/superpowers/specs/2026-08-04-shared-calendar-design.md`](../../../docs/superpowers/specs/2026-08-04-shared-calendar-design.md).
This file is the operational half: what is here, how it is wired, and how to
tell whether it is working.

```
cccalendar/
├── cccalendar.php                          the plugin: task, actions, API client
├── cccalendar.js                           day click, event dialog
├── config.inc.php.dist                     documented settings (usually not copied)
├── localization/en_US.inc                  every string on the page
├── skins/
│   ├── elastic/templates/calendar.html     the month page (see "the one odd path")
│   └── circuitcenter/cccalendar.css        the styling, in D1 Instrument Dark
└── README.md
```

No build step, no composer dependency, no npm. The upstream Roundcube image is
untouched, so patch releases keep arriving for free.

---

## How it gets into the container

Exactly the mechanism the skin already uses: one read-only bind mount, one more
name in `ROUNDCUBEMAIL_PLUGINS`. Both are already in
[`mail/docker-compose.webmail.yml`](../../docker-compose.webmail.yml):

```yaml
ROUNDCUBEMAIL_PLUGINS: archive,zipdownload,newmail_notifier,cccalendar
volumes:
  - /opt/circuits-mail/plugins/cccalendar:/var/www/html/plugins/cccalendar:ro
```

So deploying it is a `git pull` on the mail box into `/opt/circuits-mail/` plus
a container recreate — never an in-place edit on the box.

---

## Configuration

Two values are required. Both live in `/opt/circuits-mail/.env` on the mail box
and **never in git**:

```ini
CALENDAR_API_BASE=https://circuitcenter.ai/api
CALENDAR_API_SECRET=<the same value as on the web box>
```

Generate the secret the same way as `MAIL_SYNC_SECRET`:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Then recreate the container — **`restart` is not enough**, because Compose does
not re-evaluate `${VAR:-}` from `.env` on a restart:

```bash
docker compose -f docker-compose.webmail.yml up -d --force-recreate roundcube
```

`config.inc.php.dist` documents every optional setting (auth header name and
format, timeouts, TLS verification, first day of the week). It is a template for
two situations only — a local checkout, or a host that will not pass environment
variables through to PHP — because the plugin directory is mounted read-only and
a secret must not be committed. Read its header before copying it anywhere.

**When either value is missing the calendar still renders**: a full month grid
plus a notice naming the setting that is absent and the file to put it in.
Never a blank page, never a PHP warning. Creating events is disabled in that
state, because there is nowhere to send them.

---

## What it expects from the API

Four routes under the configured base, all authenticated with
`Authorization: Bearer <CALENDAR_API_SECRET>`:

| Method   | Path                     | Used for                        |
|----------|--------------------------|---------------------------------|
| `GET`    | `/calendar/events?from=&to=` | filling the month grid      |
| `POST`   | `/calendar/events`       | creating                        |
| `PATCH`  | `/calendar/events/{id}`  | editing                         |
| `DELETE` | `/calendar/events/{id}`  | deleting                        |

`from`/`to` are ISO-8601 with offset, covering the whole drawn grid (which
overhangs the month at both ends). The list response may be a bare JSON array or
an envelope (`{"events": [...]}`, `items`, `results`, `data`) — both are read, so
a later change on the API side cannot blank this page.

Each event is read for: `id`, `title`, `starts_at`, `ends_at`, `all_day`,
`location`, `meeting_url`, `notes`, `remind_day_before`, `remind_hour_before`,
`notify_email`, `notify_sms`. Anything else is ignored. A row with no `id` or an
unparseable `starts_at` is skipped rather than crashing the month.

The API also accepts a dedicated `X-Calendar-Secret` header. Either form is
fine; `Authorization: Bearer` is the default here because it mirrors the
`MAIL_SYNC_SECRET` channel already running between these two boxes. If the two
halves ever disagree, that is a one-line fix on one box —
`cccalendar_auth_header` and `cccalendar_auth_format`, both documented in
`config.inc.php.dist` — not a redeploy of both.

The secret uses the **same variable name on both boxes** (`CALENDAR_API_SECRET`),
the way `MAIL_SYNC_SECRET` does, so there is nothing to translate when copying
the value across.

---

## Security posture

**The browser never talks to the API.** Every call is made from PHP with the
shared secret in a header. There is no CORS to configure, no preflight, no
credential in a JS bundle or a network tab, and the API can stay closed to the
public internet apart from this one server-to-server path. `cccalendar.js` only
ever talks to Roundcube itself, over Roundcube's own AJAX channel, which already
carries the session cookie and the `X-Roundcube-Request` CSRF header.

**`meeting_url` is treated as attacker-influenced text**, because anyone with a
mailbox can type one and this repo has already shipped a stored-`javascript:`-in-
an-`href` bug once. It is filtered three times, and each is load-bearing:

1. on write, in `action_save()` — a value that fails never reaches the database;
2. on read, in `normalize_event()` — rows can predate this code or arrive from a
   direct API write;
3. in the browser, before the value touches an `href`.

The filter (`cccalendar::safe_http_url`) is the same shape as the site's
`safeHttpUrl`: prepend a scheme **only when there is none**, then require the
result to be `http(s)` with a host. A value that already carries a scheme keeps
it, which is precisely why `javascript:`, `data:` and `vbscript:` fall out rather
than being silently "fixed" into something that runs. Whitespace and control
characters anywhere in the string are refused outright.

Everything else is escaped with `rcube::Q()` before it is concatenated into
HTML, or handed to the client as JSON through `set_env()` (where Roundcube
applies `JSON_HEX_TAG`) and inserted with `.text()`. There is no `innerHTML` in
this plugin.

The month grid is rendered **only** by PHP. After a save or a delete the page
navigates rather than patching the DOM, so there is exactly one place that turns
an event into HTML instead of two that can disagree.

---

## The one odd path

`skins/elastic/templates/calendar.html` is not a typo, and it is not a choice.

`rcmail_output_html::parse()` resolves the template name `cccalendar.calendar`
by trying, for each entry in the skin search stack, only
`plugins/<plugin>/<skin_path>/templates/<name>.html` and
`<skin_path>/plugins/<plugin>/templates/<name>.html` — and skipping any
candidate that does not contain the plugins directory. A template at the plugin
root is never found. Of the two skins in this deployment's stack, `elastic` is
the one that is always present (circuitcenter declares `"extends": "elastic"`),
so one file there serves both skins; the same file under `skins/circuitcenter`
would 404 for anyone who switched skins in Settings. Every bundled Roundcube
plugin that ships a page does the same thing — see
`plugins/help/skins/elastic/templates/help.html`.

The skinning lives in `skins/circuitcenter/cccalendar.css`, which the plugin
loads by an explicit path rather than through `local_skin_path()` (that helper
would resolve to `skins/elastic/`, where the template lives, and quietly load
nothing).

---

## Styling

The sheet defines **no palette of its own**. It declares one token block with
Elastic-safe neutrals and a second under `html.cc` that re-points every token at
the skin's `--cc-*` custom properties. Under circuitcenter the calendar is made
of the same glass, ink, rim and phosphor as the rest of the webmail, and moving
a `--cc-*` token moves this UI with it. Under stock Elastic it degrades to a
readable neutral grid.

Stock Elastic blue (`#37beff`, `#00acff`) appears in neither branch. The skin
spent a day removing it; a plugin that reintroduces it is a defect.

It holds the skin's own invariants — no `@keyframes`, no `animation`, no
`will-change`, no `mix-blend-mode`, no `hue-rotate`, no `@import`, no webfont, no
remote image, and it introduces no new `backdrop-filter`. The two glyphs it uses
come from Elastic's already-loaded, self-hosted `Icons` family by codepoint, so
there are no external fetches. Verify with the same grep the skin uses:

```bash
grep -nE '@keyframes|animation:|@import|url\(https?:|will-change|mix-blend|hue-rotate' \
  skins/circuitcenter/cccalendar.css
# expect matches in COMMENT lines only
```

The task-rail icon is not shipped either: Elastic already defines
`.menu a.calendar:before { content: <fa-calendar-alt> }`, and the button is
registered with `class => calendar`.

---

## Verify after install

```bash
# 1. The plugin loaded. Expect cccalendar in the list.
docker exec roundcube php -r '
  include "/var/www/html/config/config.inc.php";
  print_r($config["plugins"]);' 2>/dev/null

# 2. The files are where Roundcube will look for them. All three must exist.
docker exec roundcube ls -1 \
  /var/www/html/plugins/cccalendar/cccalendar.php \
  /var/www/html/plugins/cccalendar/skins/elastic/templates/calendar.html \
  /var/www/html/plugins/cccalendar/skins/circuitcenter/cccalendar.css

# 3. The settings reached PHP. Both must be non-empty; the secret is redacted
#    to its length so nothing sensitive lands in a terminal scrollback.
docker exec roundcube php -r '
  printf("base=%s secret_len=%d\n",
    getenv("CALENDAR_API_BASE") ?: "(unset)",
    strlen((string) getenv("CALENDAR_API_SECRET")));'

# 4. Nothing is being logged as an error on a page load.
docker logs --tail 50 roundcube
```

Then sign in and click the calendar icon in the left rail.

### The owner's walkthrough (no tools needed — just eyes)

1. **Look at the left rail.** There should be a new calendar icon between
   Contacts and Settings. Clicking it should light it up gold-green like the
   Mail icon does.
2. **The month.** A grid of the current month, the month name at the top left,
   and `<` `today` `>` `+` controls at the top right. Today's square has a green
   edge. Weekday letters are small and gold.
   Wrong and worth reporting: blue anywhere · a square that is not a square ·
   the month name missing.
3. **Hover a day.** A faint `+` appears in its top right corner and the square's
   edge lights up. On a phone the `+` is always visible, because there is no
   hovering on a touchscreen.
4. **Click a day.** A dialog opens with the date already filled in. Type a title
   and press Save. The page should reload with the event sitting in that square.
5. **Add a meeting link.** Edit the event, put a Zoom/Meet/Teams URL in
   "Meeting link", save. The chip in the grid grows a small camera icon, and
   opening the event shows a green **Join meeting** button with the site's name
   beside it. Clicking it opens the meeting in a new tab.
6. **Try to break it.** Put `javascript:alert(1)` in the meeting link and save.
   It must be refused with "The meeting link must be a http:// or https:// web
   address." If it saves, stop and report it — that is the one bug in this
   feature that matters.
7. **All day.** Tick "All day"; the two time boxes go dim. Save. The chip shows
   "All day" with a gold edge instead of a green one.
8. **Narrow the window to phone width.** It stays a month — smaller squares,
   shorter chips, no times. It should never turn into a blank column.

---

## Known limits, on purpose

- **Reminders go to the fixed mailbox roster, not per-event attendees.** There is
  no attendees field; adding one is the obvious next step and was not needed to
  ship.
- **No recurring events, no RSVP, no external invitations, no CalDAV sync.** All
  real work, none of it asked for.
- **One shared calendar with no owner column.** Shared is the default state
  rather than something configured per event. Adding per-user visibility later is
  a migration, not a rewrite.
- **A month is fetched on every page load.** There is no client-side cache; the
  window is one HTTP call between two boxes on the same continent, and a stale
  calendar is worse than a fast one.
- **The dialog is the only editor.** There is no drag-to-move and no resize; both
  need a rendering path in JavaScript, which is exactly what this plugin avoids
  having.
