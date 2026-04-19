---
name: warn-docker-compose-down-v
enabled: true
event: bash
action: warn
pattern: docker[\s-]+compose\s+down\b.*(-v\b|--volumes\b)
---

⚠️ **`docker compose down -v` will DELETE named volumes**

This wipes the `postgres-data` and `n8n-data` volumes — you lose the entire local database and all n8n workflows in a single command. Recovery means re-seeding from scratch: ~15 categories, 75 subcategories, 7 suppliers, 2 sponsors, plus any parts data you've curated, plus any n8n workflow state you've configured.

**Safer alternatives:**

| Goal | Command |
|---|---|
| Stop containers, keep data | `docker compose down` (no `-v`) |
| Restart containers | `docker compose restart` |
| Recreate containers, keep data | `docker compose down && docker compose up -d` |
| Fresh prod-like seed | `./deploy.sh --reseed` (affects prod — be sure!) |

**If you genuinely mean to wipe the local DB** (testing a fresh install, migration rollback testing), back up first:

```bash
docker run --rm \
  -v circuits-com_postgres-data:/data \
  -v $(pwd):/backup \
  alpine tar czf /backup/pg-backup-$(date +%Y%m%d).tgz /data
```

Proceed only if you actually mean to lose the local data.
