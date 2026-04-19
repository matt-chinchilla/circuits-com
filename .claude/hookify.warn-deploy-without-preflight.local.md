---
name: warn-deploy-without-preflight
enabled: true
event: bash
action: warn
pattern: \./deploy\.sh\b
---

⚠️ **Consider running deploy-preflight first**

`./deploy.sh` will SSH to EC2 (`i-0d456bd12719e2176`) and rebuild prod. Before invoking it, the **deploy-preflight** subagent validates common blockers that `deploy.sh` itself doesn't catch until mid-run:

- **EC2 instance size** (rejects t3.micro/nano — they OOM during npm + pip + Docker layer build, peak > 1 GB)
- **Git state** (clean + pushed to origin; deploy.sh blocks on dirty tree)
- **DNS** (every `server_name` in `nginx/nginx.ssl.conf` resolves to the EIP — critical when adding a new hostname)
- **EC2 disk space** (< 2 GB free → build layers fail with ENOSPC)
- **Docker build-cache health** (stale cache can make rebuilds slower than cold builds)

Today's session hit `deploy.sh`'s own dirty-tree guard on an unrelated `api/app/models/user.py` whitespace diff. Running `Agent(subagent_type: "deploy-preflight")` first would have surfaced that issue with exact recovery steps (`git stash` vs discard) before the deploy retry cycle.

**If you've already invoked deploy-preflight this session and it returned READY, proceed.** Otherwise, run preflight first — it reports in ~15 seconds, and the fail-fast saves the 90-second deploy retry.
