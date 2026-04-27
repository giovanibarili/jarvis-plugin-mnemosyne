# Mnemosyne admin scripts

Maintenance utilities for the Mnemosyne plugin. All scripts assume
`DATA_DIR=~/.jarvis/mnemosyne` and a working JARVIS install.

| Script | Purpose | Example |
|---|---|---|
| `preflight-check.sh` | Standalone bash mirror of `lib/preflight.ts`. Verifies docker, python, chromadb, ports, data-dir. | `./scripts/preflight-check.sh` |
| `rebuild-indexes.ts` | Rebuild Chroma + Neo4j from the markdown source of truth. Use after embedding-model change or disaster recovery. | `npx tsx scripts/rebuild-indexes.ts` |
| `backup.sh` | Tar + gzip `short/`, `long/`, `memories/`, `config.json`, and logs into a timestamped archive. Excludes Chroma/Neo4j data (rebuildable). | `./scripts/backup.sh` |
| `restore.sh` | Restore from a backup archive. Snapshots current state into `.pre-restore-<ts>/` first. | `./scripts/restore.sh ~/.jarvis/mnemosyne/backups/mnemosyne-20260427-101500.tar.gz` |
| `wipe-test-state.sh` | **DANGER.** Stops `mnemosyne-neo4j`, removes `chroma-data/` + `neo4j-data/`. With `--all` also removes `short/`, `long/`, `memories/`. Dev/testing only. | `./scripts/wipe-test-state.sh` |
| `check-stats.ts` | Print storage stats (markdown / chroma / neo4j counts). Surfaces drift between layers. | `npx tsx scripts/check-stats.ts` |

## Notes

- All bash scripts use `set -euo pipefail`.
- TS scripts run via `tsx` (project is `"type": "module"`); install if missing:
  `npm i -g tsx` or use the workspace-level `tsx` at the JARVIS root.
- `check-stats.ts` and `rebuild-indexes.ts` require Chroma + Neo4j to be
  running. Start JARVIS (which boots them) or run preflight first.
- `restore.sh` does **not** rebuild derived indexes; run `rebuild-indexes.ts`
  afterwards.
