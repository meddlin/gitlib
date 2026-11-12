# Install & setup runbook

How to install, run, back up, restore and upgrade gitlib. It covers two places the same
`docker-compose.yml` runs:

- **Local**: your Mac, Docker Desktop. This is where you develop and try things.
- **Homelab ("production")**: a Linux VM, for example on Proxmox. This is the copy you rely on.

The point of the setup is that the two are interchangeable: you build up notes and planning data locally,
take a backup, and restore it into the homelab instance (and back).

Contents: [What runs and where the data lives](#what-runs-and-where-the-data-lives) ·
[Local install](#1-local-install-mac) · [Developing](#2-developing) ·
[Homelab install](#3-homelab-install) · [Backup and restore](#4-backup-and-restore) ·
[Moving data local → homelab](#5-moving-data-local--homelab) · [Upgrades](#6-upgrades-and-rollback) ·
[Day-to-day](#7-day-to-day-operations) · [Troubleshooting](#8-troubleshooting)

## What runs and where the data lives

`docker compose up` starts two containers:

| Service       | What it is                                   | Port (host)                                        |
| ------------- | -------------------------------------------- | -------------------------------------------------- |
| `web`         | The gitlib web app (production build)        | **4000** (`GITLIB_PORT`), on `127.0.0.1` by default |
| `meilisearch` | Full-text search over names, notes, READMEs  | `127.0.0.1:7711` (`GITLIB_MEILI_PORT`), optional    |

A third service, `gitlib`, is the CLI in the same image. It is only run on demand (backup, restore, rescans).

| Data                                                                 | Lives in                          | Backed up?           | If lost                                    |
| -------------------------------------------------------------------- | --------------------------------- | -------------------- | ------------------------------------------ |
| Notes, descriptions, favorites (`gitlib.db`)                         | volume `gitlib-data` (`/data`)    | **Yes**              | Gone for good                              |
| Planning issues and projects (`planning.db`)                         | volume `gitlib-data`              | **Yes**              | Gone for good                              |
| `config.toml` (scan roots, search settings)                          | volume `gitlib-data`              | **Yes**              | Regenerated with defaults                  |
| Repo list and detected technologies (also in `gitlib.db`)            | volume `gitlib-data`              | Yes (comes along)    | Rebuilt by **Rescan**                      |
| Search index                                                         | volume `meili-data`               | No (derived)         | Rebuilt automatically / `gitlib reindex`   |
| Your git repositories                                                | `GITLIB_REPOS` on the host        | **No**               | Re-clone from their remotes                |
| Secrets: `.env` (GitHub token, Meilisearch key)                      | `.env` on the host                | **No** (on purpose)  | Re-create; keep copies in a password manager |

Two things to take from the table: **only `gitlib-data` is irreplaceable**, and **backups deliberately contain no
secrets**, so a stolen or misplaced archive exposes your notes and config but no tokens.

> The app has **no login**. Anyone who can reach port 4000 can read and change your notes and issues. Keep it on
> your LAN/VPN, or put an authenticating reverse proxy in front of it. Do not port-forward it to the internet.

---

## 1. Local install (Mac)

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running) and git.

```bash
git clone <this-repo-url> gitlib && cd gitlib
cp .env.example .env
```

Edit `.env` if your repositories are not in `~/git` (the default). Point `GITLIB_REPOS` at the directory that contains them:

```bash
GITLIB_REPOS=/Users/you/git        # absolute path to the directory that contains your repos
```

Docker Desktop can only mount folders it is allowed to share. Your home directory is shared by default; for
anything else add it under *Settings → Resources → File sharing*.

Start it:

```bash
docker compose up -d --build
```

The first build takes a few minutes. Then open **<http://localhost:4000>**.

**Check it worked**

```bash
docker compose ps                  # web and meilisearch should both say "healthy"
curl -sI http://localhost:4000 | head -1   # HTTP/1.1 200 OK
```

In the browser the Repositories page should list your repos (it scans on first load; use **Rescan** after adding
more). If a banner says search is falling back to substring matching, Meilisearch is not healthy yet: see
[Troubleshooting](#8-troubleshooting).

**Port 4000 already taken?** Set `GITLIB_PORT=4010` (any free port) in `.env` and run `docker compose up -d`.

## 2. Developing

Run the app from source with hot reload instead of in Docker:

```bash
npm ci
npm run web                        # http://localhost:4000 (fails if 4000 is busy, rather than picking another port)
npm run typecheck && npm test      # what CI runs
```

Things to know:

- **Separate data.** `npm run web` and the `gitlib` CLI use `~/.git-library` on your Mac. The Docker copy uses
  its own volume. They do not share notes or planning issues.
- **Which one to carry to the homelab.** Backups restore cleanly between *Docker* instances. Data from
  `~/.git-library` records your Mac's absolute paths (`/Users/you/git/...`), which do not exist in the
  container (`/home/node/git/...`), so its notes and descriptions would not line up with the homelab's
  repos. If you want to move data between machines, keep that data in the Docker instance.
- **Search while developing natively.** Compose publishes Meilisearch on `127.0.0.1:7711`. Start it with
  `docker compose up -d meilisearch` and run the app with `GITLIB_MEILI_HOST=http://127.0.0.1:7711 npm run web`.
  Without it, search falls back to substring matching.
- **Trying a code change in Docker:** `docker compose up -d --build web`.

## 3. Homelab install

**VM:** Debian 12/13 or Ubuntu 24.04 on Proxmox. 2 vCPU, 2 GB RAM and 20 GB disk is plenty. Use a regular VM.

**1. Install Docker Engine and the Compose plugin**

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"    # log out and back in afterwards
docker compose version
```

**2. Get the code**

```bash
sudo mkdir -p /opt/gitlib && sudo chown "$USER": /opt/gitlib
git clone <this-repo-url> /opt/gitlib && cd /opt/gitlib
```

Build on the VM rather than shipping an image from your Mac: an Apple Silicon Mac builds `arm64` images, and
the VM is almost certainly `amd64`.

**3. Put your repositories on the VM**

Gitlib only sees repositories that are on disk. Clone them into one directory, or mount a share from your NAS:

```bash
mkdir -p /srv/git && cd /srv/git
git clone <remote> ...             # or rsync from your Mac, or mount NFS/SMB at /srv/git
```

Keep the **same folder layout as on your Mac** (`/srv/git/team/api` where it was `~/git/team/api`): notes and
descriptions are tied to each repo's path *relative to the scan root*.

The container sees this directory through a read-write bind mount as a non-root user (uid 1000). That is what lets
**Clone locally** in the app put repositories here, on the server's disk rather than inside the container, so they
survive `docker compose stop/start`, `down` and rebuilds. Two requirements:

- The directory must exist and be **writable by uid 1000**. The first user on Ubuntu/Debian is uid 1000, so
  `mkdir -p /srv/git` as that user is enough; otherwise run `sudo chown 1000:1000 /srv/git`. If you let Docker create
  a missing directory it is owned by root and cloning fails with `Permission denied`.
- Existing repositories only need to be readable. The image already tells git to trust the mount, so differing file
  owners are fine.

Repositories cloned from the app are owned by uid 1000 on the host.

**4. Configure**

```bash
cp .env.example .env
```

```bash
GITLIB_REPOS=/srv/git
GITLIB_BACKUPS=/srv/gitlib-backups       # somewhere outside the checkout, ideally another disk or an NFS share
GITLIB_BIND=0.0.0.0                      # reachable from the LAN
TZ=America/Chicago
MEILI_ENV=production
GITLIB_MEILI_API_KEY=<output of: openssl rand -hex 24>
GITLIB_GITHUB_TOKEN=<optional, read-only>
GITLIB_GITLAB_TOKEN=<optional, read_api>   # plus GITLIB_GITLAB_URL if self-hosted
```

`GITLIB_BACKUPS` must exist and be writable by uid 1000 (`mkdir -p /srv/gitlib-backups` as your user normally
works, since the first user on Debian/Ubuntu is uid 1000; otherwise `sudo chown 1000:1000 /srv/gitlib-backups`).

**5. Start and check**

```bash
docker compose up -d --build
docker compose ps                         # both "healthy"
curl -sI http://localhost:4000 | head -1
```

Open `http://<vm-ip>:4000` from another machine. If it does not load:

- **"Connection refused" while `curl localhost:4000` works on the VM.** `GITLIB_BIND` is still its default
  `127.0.0.1`, so the port is only published on the VM itself. `docker compose ps` shows `127.0.0.1:4000->4000/tcp`
  instead of `0.0.0.0:4000->4000/tcp`. Fix it and recreate the container (a restart is not enough):

  ```bash
  sed -i 's/^GITLIB_BIND=.*/GITLIB_BIND=0.0.0.0/' .env
  docker compose up -d
  ```

- **Times out.** The VM's firewall is blocking TCP 4000. Allow it from your LAN
  (`sudo ufw allow from 192.168.1.0/24 to any port 4000` on Ubuntu).
- **Wrong address.** Check the VM's current IP with `ip -4 addr`; a DHCP lease can change.

**6. Make it survive reboots.** Containers use `restart: unless-stopped` and Docker starts at boot, so nothing
more is needed. Confirm once with `sudo reboot`, then `docker compose ps`.

**7. Schedule backups and take the first one.** See [Backup and restore](#4-backup-and-restore). Don't skip this.

**Optional: HTTPS and a login.** Put Caddy, Nginx Proxy Manager, Traefik or Authelia in front, and set
`GITLIB_BIND=127.0.0.1` so the proxy is the only way in.

### Go-live checklist

- [ ] `docker compose ps` shows `web` and `meilisearch` healthy
- [ ] The Repositories page lists your repos; opening one shows its README
- [ ] `MEILI_ENV=production` and a key set; search results highlight matches
- [ ] A backup was taken, **verified**, and copied off the VM
- [ ] A cron job or timer runs `scripts/backup.sh`
- [ ] `.env` is stored in your password manager
- [ ] You have done one test restore (into a scratch VM or after the first backup, see below)

---

## 4. Backup and restore

### What a backup is

`scripts/backup.sh` writes one file: `backups/gitlib-backup-<UTC timestamp>.tar.gz`. Inside it:

| File            | Contents                                                                              |
| --------------- | ------------------------------------------------------------------------------------- |
| `config.toml`   | Scan roots, search settings                                                           |
| `gitlib.db`     | Notes, descriptions, favorites (plus the rebuildable repo list)                       |
| `planning.db`   | Planning issues and projects                                                          |
| `manifest.json` | Time, host, row counts, schema version, and a SHA-256 for every file                  |

How it stays trustworthy:

- **Safe while the app runs.** Databases are copied with SQLite's `VACUUM INTO`, which produces a consistent
  snapshot even if someone is saving a note at that moment. No downtime.
- **Read back before it counts.** Every new archive is unpacked and checked (checksums, SQLite integrity)
  before the file is put in place. A half-written archive never appears under the final name.
- **Private.** Archives are mode `0600` and hold no tokens or keys.
- **Never overwrites.** Each backup has its own timestamped name; old ones are pruned only by the retention
  setting below.

### Take a backup

```bash
scripts/backup.sh
```

```
Backed up /data to /backups/gitlib-backup-20261102T031500Z.tar.gz (14.2 KiB).
  created   2026-11-02T03:15:00.123Z on 4f1c0a9b2d3e (gitlib 0.1.0)
  files     config.toml, gitlib.db, planning.db
  contents  42 repos, 5 notes, 12 descriptions, 3 favorites, 9 issues, 2 projects
```

It keeps the newest 14 archives in that directory (`GITLIB_BACKUP_KEEP=30 scripts/backup.sh` to change).

### Schedule it (homelab)

Daily at 03:15 with cron, as the user that runs Docker:

```bash
crontab -e
```

```cron
15 3 * * * cd /opt/gitlib && ./scripts/backup.sh >> "$HOME/gitlib-backup.log" 2>&1
```

### Keep a copy somewhere else

A backup on the same disk as the data protects against mistakes, not against the disk (or VM) dying. Pick one:

```bash
# push to a NAS (no --delete, so the NAS keeps what the VM has pruned)
rsync -a /srv/gitlib-backups/ nas:/volume1/backups/gitlib/
```

or point `GITLIB_BACKUPS` straight at an NFS mount, or let Proxmox take VM backups (*Datacenter → Backup*) as a
second layer. Add the rsync line to the same cron entry, after `backup.sh`.

### Check a backup (do this occasionally)

```bash
docker compose run --rm --no-deps gitlib backup verify /backups/gitlib-backup-20261102T031500Z.tar.gz
```

This re-checks every checksum and SQLite integrity, and tells you the row counts it holds, without touching
live data. A backup you have never restored is a hope, so once in a while run a real drill: restore it into a
scratch VM or onto your Mac and open the app.

### Restore

```bash
scripts/restore.sh backups/gitlib-backup-20261102T031500Z.tar.gz
```

What it does, in order:

1. **Verifies** the archive and prints what is in it. A corrupt, edited or foreign file is refused here.
2. **Asks you to confirm** (`-y` skips this).
3. **Stops the web app** so nothing writes while files are swapped.
4. **Saves what is there now** as `pre-restore-<timestamp>.tar.gz` next to your other backups.
5. **Replaces** `config.toml`, `gitlib.db`, `planning.db`, clearing any stale SQLite journal files first.
6. **Starts the web app again.** On its first page load it rescans and rebuilds the search index.

The archive can be anywhere on the host, not only in `backups/`.

**Undo a restore:** the `pre-restore-*.tar.gz` file is a normal backup, so restoring it puts things back as
they were:

```bash
ls backups/pre-restore-*
scripts/restore.sh backups/pre-restore-20261102T040000Z.tar.gz
```

Retention (`--keep`) only prunes `gitlib-backup-*` files, so `pre-restore-*` copies stay until you delete them.

### Restore on a brand-new machine (disaster recovery)

1. Do [Homelab install](#3-homelab-install) steps 1–4 (Docker, code, repos, `.env` from your password manager).
2. Copy the newest archive from your off-VM copy into `GITLIB_BACKUPS`.
3. `docker compose up -d --build`, then `scripts/restore.sh <archive>`.
4. Open the app and press **Rescan**.

### Refusals you may see

| Message                                                                  | Meaning and fix                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `planning.db is at schema version N, newer than this gitlib understands` | The backup came from a newer gitlib. Update this machine (`git pull && docker compose up -d --build`) and retry. |
| `does not match its checksum`                                            | The file was modified or damaged in transit. Re-copy it, or use an earlier backup.                    |
| `Nothing to back up ... missing ...`                                     | The data volume is empty or `GITLIB_HOME` points elsewhere. Make sure the app has been opened once.   |
| `The archive contains unexpected entries`                                | Not a gitlib backup. Restore only archives made by `scripts/backup.sh`.                               |

### Without Docker

The same commands exist in the CLI, for an install that runs from source (data in `~/.git-library`):

```bash
npm run gitlib -- backup create ~/gitlib-backups --keep 14
npm run gitlib -- backup verify ~/gitlib-backups/gitlib-backup-....tar.gz
npm run gitlib -- backup restore ~/gitlib-backups/gitlib-backup-....tar.gz --yes   # stop the web app first
```

`restore` without `--yes` only verifies and describes the archive.

### What is *not* covered

- **Your repositories.** They are checkouts of remotes; back up what is not pushed the way you normally would.
- **Secrets.** `.env` holds your GitHub token and Meilisearch key. Keep it in a password manager.
- **The search index.** It is rebuilt from the scan.
- **A raw copy of the volume** (`docker run --rm -v gitlib_gitlib-data:/data -v "$PWD":/b busybox tar czf /b/volume.tgz -C /data .`)
  also works as a last-resort, but it is not checksummed or schema-checked, and it can catch a database mid-write.

---

## 5. Moving data local → homelab

The workflow this setup was built for. Do it as often as you like; each restore overwrites the homelab's
data with the backup (and saves what it replaced).

1. **Mac:** `scripts/backup.sh`
2. **Copy:** `scp backups/gitlib-backup-<stamp>.tar.gz you@homelab:/srv/gitlib-backups/`
3. **Homelab:** make sure it runs the **same or newer** gitlib than the Mac:
   `cd /opt/gitlib && git pull && docker compose up -d --build`
4. **Homelab:** `scripts/restore.sh /srv/gitlib-backups/gitlib-backup-<stamp>.tar.gz`
5. Open the homelab app and press **Rescan**.

Checks that save grief:

- **Direction matters.** Restoring *homelab → Mac* works the same way. What does not work is restoring a
  backup from a **newer** gitlib into an older one (it is refused, by design, to protect planning data).
- **Same repo layout** on both sides ([Homelab install](#3-homelab-install) step 3). A repo that is missing on
  the target is listed as missing and keeps its notes; they reappear when the repo does.
- **`config.toml` travels with the data.** It contains only scan roots (`~/git`, which is `/home/node/git` in
  the container on both ends). Search host and key come from `.env` and are not overwritten.
- **If the homelab already has data you care about**, back it up first (`scripts/backup.sh` there). Restore also
  saves a `pre-restore-*` copy, but an explicit backup is easier to find.
- It is a **replace, not a merge**. Don't edit on both machines between restores.

---

## 6. Upgrades and rollback

```bash
scripts/backup.sh                                  # always first
git pull
docker compose up -d --build
docker compose ps                                  # healthy?
```

Planning data has a versioned schema and upgrades itself the first time the new version starts. That is a
one-way door: an **older build refuses to open a database written by a newer one**. So to roll back code:

```bash
git checkout <previous-tag-or-commit>
docker compose up -d --build                       # fails to open planning.db if it was upgraded
scripts/restore.sh backups/<the backup from before the upgrade>
```

Upgrading Meilisearch (changing the pinned `getmeili/meilisearch` version in `docker-compose.yml`) needs a fresh
index, which is safe because the index is derived: `docker compose down && docker volume rm gitlib_meili-data`,
then `docker compose up -d`.

## 7. Day-to-day operations

```bash
docker compose ps                         # status and health
docker compose logs -f web                # follow the app log
docker compose restart web
docker compose stop                       # stop everything, keep data
docker compose exec web gitlib scan       # rescan repos from the CLI
docker compose exec web gitlib reindex    # rebuild the search index
docker compose run --rm gitlib list       # one-off CLI command
```

**Danger:** `docker compose down -v` deletes the volumes, which is your data. `docker compose down` (no `-v`) is safe.

## 8. Troubleshooting

| Symptom                                                         | Likely cause and fix                                                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port is already allocated` / `address already in use`          | Something else uses the port. Set `GITLIB_PORT` (or `GITLIB_MEILI_PORT`) in `.env` to a free one. `npm run web` also refuses to start on a busy 4000.             |
| No repositories listed                                          | `GITLIB_REPOS` (default `~/git`) is wrong, not shared with Docker Desktop, or empty. Check `docker compose exec web ls /home/node/git`. Press **Rescan** after fixing.              |
| Repo pages show no GitHub data / community scores               | Add `GITLIB_GITHUB_TOKEN` to `.env` (anonymous GitHub limit is 60 requests/hour), then `docker compose up -d`. Confirm the repo has a GitHub `origin` remote. Scores are stored and refreshed daily; press **Refresh scores** to fetch now. |
| No blue "needs `git pull`" dots, or a note says "Couldn't check N repositories for new upstream commits" | The server asks each repo's remote itself (`git ls-remote`), so the remote must be reachable from where it runs, with no prompt. In Docker that means public HTTPS remotes work, but SSH remotes (`git@github.com:…`) and private HTTPS ones fail unless you give the container keys or a credential helper. The note shows git's first error. Answers are cached for five minutes; press **Rescan** to check again. |
| GitHub / GitLab tab is empty or says "isn't included"           | The Repositories page lists GitHub repos with `GITLIB_GITHUB_TOKEN` and GitLab projects with `GITLIB_GITLAB_TOKEN` (`read_api`; or `GITLIB_GITLAB_USERNAME` for public ones, plus `GITLIB_GITLAB_URL` if self-hosted). Add it to `.env`, run `docker compose up -d`, then press **Refresh**. A rejected token (401) is reported on the page, with the last stored list still shown. The lists are stored in the database and re-checked every `GITLIB_REPO_REFRESH_HOURS` (default 6). |
| "Search falls back to substring matching"                       | Meilisearch is down or unreachable. `docker compose ps`, `docker compose logs meilisearch`. After changing `GITLIB_MEILI_API_KEY` run `docker compose up -d` so both containers get the new value. |
| `meilisearch` unhealthy, logs say "database version (X) is incompatible with your current engine version (Y)" | The data volume was written by another Meilisearch version. Compose sets `MEILI_UPGRADE_DB` so this normally migrates itself; if the upgrade fails or you rolled the image back (downgrades are not supported), the index is derived, so reset it: `docker compose down && docker volume rm gitlib_meili-data && docker compose up -d`. Notes and settings in `gitlib-data` are not affected. |
| `meilisearch` will not start with `MEILI_ENV=production`        | Production mode requires a key of at least 16 characters in `GITLIB_MEILI_API_KEY`.                                                                               |
| Ask panel says "Cannot reach Ollama at …"                       | Inside Docker `localhost` is the container. Set `GITLIB_OLLAMA_HOST` in `.env` to the Ollama machine's address, then `docker compose up -d`. On that machine Ollama must listen beyond loopback (`OLLAMA_HOST=0.0.0.0:11434`) and its firewall must allow the port. Test with `curl http://<host>:11434/api/version`. |
| Ask panel is slow to answer, or the model reloads between questions | Ollama unloads an idle model after 5 minutes (`OLLAMA_KEEP_ALIVE` on that machine), and reloads it when a request changes the context size, so other tools using the same Ollama with a different context size cause reloads. Check what is loaded with `ollama ps` on that machine. |
| `permission denied` writing to `/backups`                       | The backups directory is not writable by uid 1000: `sudo chown 1000:1000 "$GITLIB_BACKUPS"`.                                                                      |
| **Clone locally** fails with `Read-only file system`            | The container still has the old read-only repos mount. Pull the current `docker-compose.yml` and run `docker compose up -d` to recreate it (a restart keeps the old mount). Check with `docker compose exec web touch /home/node/git/.w && docker compose exec web rm /home/node/git/.w`. |
| **Clone locally** fails with `Permission denied`                | The host directory behind `GITLIB_REPOS` is not writable by uid 1000 (Docker creates a missing one as root). `sudo chown 1000:1000 "$GITLIB_REPOS"`, then try again. |
| **Clone locally** fails with `could not read Username`          | The repository is private. Cloning uses its plain HTTPS URL with no credentials, so only public repos clone from the app. Clone private ones on the server yourself (`git clone` over SSH or with a credential helper) and press **Rescan**. |
| Notes missing after moving to a new machine                     | The repos are at a different path under the scan root, or you restored from a non-Docker `~/.git-library` ([Developing](#2-developing)).                          |
