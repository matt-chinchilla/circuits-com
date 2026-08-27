# Project command aliases

The custom commands wired into the shell for operating circuitcenter.ai, and
the scripts behind them. All three aliases live in `~/.zshrc`; the snippet at
the bottom reproduces them on a fresh machine.

| Alias | Backed by | One-liner |
|---|---|---|
| `circuitcenter` | `deploy.sh` | Deploy + operate the **web** EC2 box (build, reseed, logs, certs, full DB mirror) |
| `circuits` | `pull-prod-data.sh` / `push-prod-data.sh` / `scripts/fakeuser.sh` | Day-to-day ops: move data between prod and local, drive the presence fakes |
| `mxupdate` | `mail-update.sh` | Push the webmail skin + plugins to the **mail** EC2 box (a separate instance) |

Prerequisites for anything that touches prod: AWS CLI configured
(`aws sts get-caller-identity` works) and `~/.ssh/id_ed25519`. SSH rides EC2
Instance Connect (60-second keys pushed automatically), so no firewall holes
and no static allowlists. Local-data commands need the dev stack running
(`docker compose up -d`).

---

## `circuitcenter` — deploy & operate the web server

| Command | What it does | Danger level |
|---|---|---|
| `circuitcenter` | Full deploy: git pull on the box, rebuild frontend + api + the three worker services, `up -d`, nginx restart. Expect ~1–2 min of `/api` 502 while alembic + seed run. | Prod-changing |
| `circuitcenter --frontend` | Frontend-only rebuild + nginx restart. The fast path for pure SCSS/TS changes — no api recreate, no 502 window. | Prod-changing |
| `circuitcenter --reseed` | Full deploy **plus** `TRUNCATE sponsors, category_suppliers, categories, suppliers CASCADE` and reseed. The cascade reaches users → calendar; the script backs the calendar up and restores it. Admin-created rows outside the seed are wiped. | **Destructive (prod)** |
| `circuitcenter pull` | Mirror the **entire** production database into local: backs up local first, then drop/recreate + restore. Local becomes an exact prod snapshot. | Destructive (local) |
| `circuitcenter --status` | `docker ps` on the box. | Read-only |
| `circuitcenter --logs` | Tail all container logs (Ctrl+C to stop). | Read-only |
| `circuitcenter --cert-renew` | Stop nginx → `certbot renew --standalone` → start nginx. | Prod-changing |
| `circuitcenter --help` | Print usage. | Read-only |

Deploy expectations: run the `deploy-preflight` agent first; commits must be
pushed to `origin/master`; **any uncommitted/untracked file makes the script
bail with only a two-line warning and exit 0** — keep backups outside the
repo (`~/circuits-backups/`).

---

## `circuits` — data movement & ops shortcuts

### The three data movers (easy to confuse — this is the difference)

| Command | Direction | Scope | Semantics |
|---|---|---|---|
| `circuitcenter pull` | prod → local | **whole database** | Drop local, restore prod dump. Local-only anything is gone (backed up first). |
| `circuits pull` | prod → local | reporting + catalog | **Additive** for catalog (natural keys, upsert; local-only rows survive); reporting tables (`page_views`, `messages`) are replaced because prod is the truth for them. Does NOT move users. |
| `circuits pull --users` | prod → local | registered customers | **Additive**, `role='user'` only, upserted on `lower(email)`. Staff rows are never touched — local admin passwords are deliberately not prod's. Company links travel by NAME. Opt-in because it carries real addresses and password hashes onto a dev machine. |
| `circuits push` | local → prod | **catalog only** | **Additive** upsert by natural keys; never deletes; asks for confirmation before touching prod. Reporting deliberately cannot be pushed. |

`circuits pull` / `circuits push` share one transfer pair —
`scripts/catalog_export.py` → `scripts/catalog_load.py` — which moves
suppliers / parts / listings / price breaks keyed by slug, SKU, and name
(never UUIDs: those are minted per database, and per-environment surrogate
FKs like `manufacturer_id` are deliberately stripped; the seed re-links them
by name on the next api start). The loader commits every 500 records and is
idempotent, so an interrupted run loses nothing and a re-run converges.

### Modes

| Command | What it does |
|---|---|
| `circuits pull` | Both pulls: reporting, then catalog. |
| `circuits pull --reporting` | Just `page_views` + `messages` (the standing post-deploy rule). |
| `circuits pull --catalog` | Just the catalog upsert (after import runs on prod). |
| `circuits pull --users` | Just the registered customers. NOT part of the default run. |
| `circuits push` | Export the local catalog, confirm, load into prod. Reminders print for the seo-manifest regen (new part pages need it) and the manufacturer relink (next deploy). |
| `circuits --fakeuser --up [N]` | Raise the admin presence-fake count (0–10). |
| `circuits --fakeuser --down [N]` | Lower it; **bare `--down` clears everything** (count and named individuals). |
| `circuits --fakeuser --name <n>` | Show a named individual from the roster (`--name <n> --down` removes them). Names are validated against the roster parsed from the source — a typo dies with the valid list. |
| `circuits --fakeuser --status [--prod]` | Show the current fakes, locally or on prod. |
| `circuits --fakeuser ... --prod` | Any of the above against production instead of local. |

Roster edits (the fictional names) are CODE (`admin_presence.py`) — they ship
via `docker compose up -d --build api` / a deploy, not a reseed.

---

## `mxupdate` — webmail deploys (the mail box)

The mail server (`mail.circuitcenter.ai`, `i-0137a3f25f5c7bec5`) is a separate
instance whose files are **copies, not a git checkout** — this script is its
whole deploy story. Access tunnels through an EC2 Instance Connect *endpoint*
(IAM-authorized, works from any network).

| Command | What it does |
|---|---|
| `mxupdate` | Push the Roundcube skin + both plugins (cccalendar, ccsignature). |
| `mxupdate --skin` | Skin only — the common case for CSS tweaks. |
| `mxupdate --plugins` | Plugins only. |
| `mxupdate --dry-run` | Show what would change; copy nothing. |

All targets are read-only bind mounts, so changes are live on the next
request — no container restart, just a hard refresh.

---

## Not aliased, but part of the same toolbox

| Command | Purpose |
|---|---|
| `docker compose exec -T api python -m app.db.seed` | Idempotent seed (also runs on every api container start). Step 5 relinks `parts.manufacturer_id` by name. |
| `node frontend/scripts/gen-seo-manifest.mjs [api-base]` | Regenerate the committed SEO manifest after the catalog grows — without it, new part pages serve the generic shell. |
| `node frontend/scripts/gen-header-aliases.mjs` | Regenerate the BOM tool's header-alias map from the attested raw JSON. |
| `php mail/tests/run.php [filter]` | The mail harness's dependency-free tests (image tests skip locally — run `mail/tests/run-in-container.sh` where the risk lives). |
| `cd api && pytest tests/ -q` | Backend suite. |
| `cd frontend && npx tsc -b && npx eslint --ext .ts,.tsx src/ && npm test` | The frontend gates (`tsc -b` is the real type gate — `tsc --noEmit` is a documented no-op here). |

---

## The `~/.zshrc` block (for a fresh machine)

```sh
# circuitcenter.ai dev CLI (deploy.sh subcommands)
alias circuitcenter='/home/matthew/circuits-com/deploy.sh'

# circuitcenter.ai ops shortcuts
circuits() {
  case "$1" in
    pull) shift; "$HOME/circuits-com/pull-prod-data.sh" "$@" ;;
    push) shift; "$HOME/circuits-com/push-prod-data.sh" "$@" ;;
    --fakeuser) shift; "$HOME/circuits-com/scripts/fakeuser.sh" "$@" ;;
    *) echo "usage: circuits pull [--reporting|--catalog|--users] | circuits push | circuits --fakeuser --up/--down [N] | --status [--prod]" ;;
  esac
}

# Push the webmail skin + plugins to the mail server (separate EC2 box).
alias mxupdate="$HOME/circuits-com/mail-update.sh"
```
