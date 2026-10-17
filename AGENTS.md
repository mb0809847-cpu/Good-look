# Base44 Dev Environment

## Project Overview
A single static HTML page (`index.html`) — a Portuguese welcome page. No framework, no build step, no backend, no database.

## Running
```
docker compose -f docker-compose.base44.yml up -d
```
Serves `index.html` via nginx (alpine) on host port 3000. The source directory is bind-mounted read-only, so edits to `index.html` are visible immediately on refresh (no rebuild needed). Call `reload_preview` after edits to refresh the preview iframe.

## Notes
- The repo root directory has restrictive (700) permissions in the sandbox, so `nginx.conf` runs the worker as `root` to read the bind-mounted files. This is sandbox-only and does not affect the served content.
- The original user file `Bem vindo ao meu site` is preserved; `index.html` is the clean copy that nginx serves as the index.
- No external credentials or secrets are required.
