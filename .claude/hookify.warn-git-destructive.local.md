---
name: warn-git-destructive
enabled: true
event: bash
action: warn
pattern: git\s+(checkout\s+--\s|restore\s+(?!--staged)|reset\s+--hard|clean\s+-f)
---

⚠️ **Destructive git command — can silently discard uncommitted work**

This command type overwrites or deletes working-tree changes with no undo path:

| Command | What it destroys |
|---|---|
| `git checkout -- <file>` | Discards unstaged changes to `<file>` |
| `git restore <file>` | Same, modern syntax |
| `git reset --hard` | Discards ALL unstaged + staged changes |
| `git clean -f` | Deletes untracked files permanently |

**Recoverable alternatives:**

| Goal | Safer command |
|---|---|
| "Save changes for later" | `git stash push <file>` → `git stash pop` to restore |
| "Save all changes with a label" | `git stash push -m "descriptive label"` |
| "Just view the changes first" | `git diff <file>` |
| "Revert to last commit but keep files staged" | `git reset` (without `--hard`) |

**Context from this project:** today's session used `git stash push -m "user.py whitespace reformat"` — NOT `git checkout --` — specifically to preserve the IDE's auto-reformat diff before deploying. Stash is recoverable via `git stash pop`; `git checkout --` would have destroyed it. This hook exists to make the safer default obvious.

If you're certain the change is worthless, proceed. If there's any doubt, `git stash` first (one extra keystroke buys full recoverability).
