---
name: trace-studio
description: Turn an AI agent run into a replay you can watch and share. Reads a Claude Code session (~/.claude/projects/*/*.jsonl) or an Anthropic or OpenAI message log, anonymises it first (paths, home folders, user, host and project names, emails, keys and tokens, network addresses, plus words you list), then makes a single-file offline HTML replay (play button, scrubber, tool calls with folded outputs, inline diffs), a 30 to 60 second narrated summary video, and a stats JSON (time, tool calls, failures, files and lines changed, tokens). Use whenever the user wants to replay, share, review, debug, document or demo an agent or coding-assistant session; asks "what did the agent do", "share this Claude Code session", "turn my transcript into a video", "visualise the tool calls", "export the session as HTML", "anonymise this transcript", "session stats", "how many tool calls did it use"; or wants a post-mortem of a run.
---

# trace-studio

Transcript → **anonymise** → parse → **replay.html** + **stats.json** + **story.json** → **summary.mp4**. Plain Node 18+ for everything except the video, which also uses ffmpeg, Playwright with a browser, and Kokoro (local text to speech). Nothing is uploaded anywhere.

Skill folder: `~/.claude/skills/trace-studio/` (written `$T` below). Every command is `$T/trace-studio <command>`; `$T/trace-studio help` lists them.

## Workflow

1. **Find the transcript.** `$T/trace-studio list` shows Claude Code sessions on this machine, newest first (date, size, path). `latest` means the newest one, which is usually the session you are in right now. It prints the path it picked: tell the user which session that is and confirm it is the one they mean before building. Other inputs: an Anthropic Messages log, an OpenAI Chat Completions log or a list of OpenAI Responses items, as `.json` or `.jsonl` (README.md, "Inputs").
2. **Ask about private words.** Redaction is best-effort pattern matching: it catches things with a recognisable shape and names the log gives away, but it cannot know a client's name, a product code name, the organisation or repository names, or a colleague's name. Ask: "Which names of your organisation, repositories, clients, products or people must not appear?" Pass each with `--term NAME` (or `redact.terms` in a config file). Keep a value with `--allow TEXT`.
3. **Build:** `$T/trace-studio build <transcript> --out <dir> [--term X]...`. It writes `redaction.json`, `stats.json`, `replay.html`, `story.json`, then renders `summary.mp4` with a poster and captions. Add `--no-video` for the page and stats only (seconds, no extra tools). Every output is scanned for anything private before it is written; if the scan finds something, nothing is written and the command says what kind of item it was.
4. **Look at what you made before handing it over.**
   - Open `replay.html` and skim it **with the user**: tell them where it is, open it in their browser, and ask them to look through it before sharing (with Playwright you can also take screenshots and Read them). Check the title, the person's messages, tool outputs and diffs. Do not call the page safe to share until the user has looked.
   - Read `redaction.json`: counts per kind. Zero home paths on a coding session is suspicious: check the page.
   - Search the page for the user's real name, company and project names: `$T/trace-studio scan <file> --term NAME` exits 1 when it finds one.
   - For the video, Read the poster (`summary-poster.jpg`) and a few frames pulled with ffmpeg (`-vf fps=1/6,tile=2x4`) to check every scene. You cannot hear the audio; check the duration and loudness with `ffmpeg -i summary.mp4 -af volumedetect -f null -` and say that you did.
5. **Improve the narration if asked.** `story.json` holds one `say` line per scene, filled in from counted facts. The first scene says only that the agent was given a task. You may rewrite lines in plain words (for example, what the task was), then run `$T/trace-studio video <dir>/story.json`. Only state what the transcript shows. Never claim the agent "fixed" something unless a later step shows it working, and never invent numbers.
6. **Report back:** the paths, the step and tool counts, how many items were replaced and of which kinds, anything the scan flagged, and the reminder below.

Always tell the user: **"Redaction is best-effort pattern matching. Please skim replay.html before you share it, and tell me any names to add with --term."** Thinking text is left out unless they ask for `--thinking`.

## Commands

| Command | What it does |
|---|---|
| `list [--all]` | Claude Code sessions on this machine (newest first) |
| `build <t> [--out DIR] [--no-video]` | all outputs |
| `html <t> [-o FILE]` | the replay page |
| `stats <t> [-o FILE]` | stats JSON (stdout without `-o`) |
| `redact <t> [-o FILE]` | an anonymised copy of the transcript plus `.redaction.json` |
| `story <t> [-o FILE]` | the video's scenes and narration, to edit |
| `video <story.json> [-o FILE]` | render the MP4, poster and captions |
| `scan <file...>` | look for private items left in any file; exit 1 if found |
| `check` | what is installed and how to fix what is missing |
| `test` | self-tests |

Options: `--config FILE`, `--allow TEXT`, `--term TEXT` (both repeatable), `--keep-paths`, `--keep-ips`, `--keep-project-name`, `--thinking`, `--max-output N` (characters kept per tool output, default 12000), `--title TEXT`, `--no-fonts`, `--voice NAME` (Kokoro voice, default `af_heart`), `--no-voice` (silent, timed by word count), `--format landscape|square|vertical`, `--force` (write even when the final scan flags something; only when the user has looked and agrees).

Config file (`--config trace-studio.json`):

```json
{ "redact": { "terms": ["Initech", "Project Falcon"], "allow": ["support@example.com", "/^\\/opt\\/tools\\//"], "keepIps": false },
  "maxOutput": 12000, "thinking": false, "title": "Fixing the CSV import", "video": { "format": "vertical", "voice": "bf_emma" } }
```

## What the anonymiser does

Invisible characters (zero-width spaces, soft hyphens) are removed first, so they cannot split a key. Then, in this order:

- **Keys and tokens:** values of secret-named environment variables of this shell; `sk-`, Stripe `sk_`/`rk_`/`pk_` and `whsec_`, AWS ids, GitHub, GitLab, Slack (tokens and webhook URLs), Discord webhooks, Google, Hugging Face, npm, SendGrid, Twilio, DigitalOcean, JWTs, PEM/OpenSSH/PGP private key blocks, keys wrapped over several lines, Azure `AccountKey=`/`SharedAccessKey=`/`sig=`, `Bearer`/`Basic` headers, `Cookie`/`Set-Cookie` values and `curl -b`, `--password`/`--token` style flags, `mysql -p…`, `curl -u user:pass`, passwords in URLs (also with an empty user), and any `NAME=value` or `name: value` whose name contains password, passwd, pwd, secret, token, api key, private key, access key, credential or auth (`DB_PASSWORD`, `SECRET_KEY_BASE`, `X-Api-Key`, `_authToken`). For password names any value of 3+ characters is replaced; for the others the value must look like a secret (digits, mixed case, symbols or length), so `token: expired` and `password = getPassword()` stay.
- **Emails**, including quoted local parts, international domains, `%40`, `\u0040` and the full-width at sign.
- **Users and hosts:** shell prompts, `ssh`/`scp`/`rsync` targets, this machine's user and host names, user names seen in any home folder in the log; names of 4+ characters are replaced inside longer words too (`casey_test`).
- **Folders:** the project folder (shown as `<project>`), its folder name and the folders between it and home (as words anywhere: `git clone .../acme-portal.git`; keep one with `--allow NAME` or all with `--keep-project-name`), any home folder (`/home/x`, `/Users/x`, `/Users/Bob Smith/`, `/Volumes/Disk/Users/x`, `/mnt/c/Users/x`, `C:\Users\x`, double-backslash forms, `/root` become `~`), UNC paths, other absolute paths under private folders (shortened to `/…/file`).
- **Network:** internal host names (`.local`, `.internal`, `.lan`, `.corp`), IPv4 (except loopback), IPv6 and MAC addresses.
- **Your words:** every `--term`, anywhere in a word, any case (terms under 4 characters as whole words).

Fields that identify an account or request are dropped and inline images removed. The final scan reruns these patterns on every output, plus looser checks of its own: long random-looking strings near secret words, any `-----BEGIN` block that is not public, credentials in URLs. All outputs are scanned before any is written; outputs of an earlier run in the same folder are removed, and output paths that are symbolic links are refused.

Also replaced: Telegram, Discord, Replicate, Groq and Mailgun tokens; names from `whoami`, `id`, passwd lines and git authors; zsh and bracket prompts; values split from their names (YAML `name:`/`value:`, XML, JSON pairs, lists, Markdown tables); `sshpass`, `redis-cli -a`, `openssl -k`, `htpasswd -b`, `chpasswd`, `.pgpass`; query-string signatures, bare AWS secret keys, base64 that hides a secret; card numbers, SSNs, IBANs, phone numbers; colour codes are stripped first. The terminal lists app and folder names in system paths as a hint.

**Still kept:** host names on public domains (`db.example.com`), secrets with no recognisable shape and no secret word near them, names nobody listed. Read the page before sharing.

## Troubleshooting

- **"no steps found"**: the file is not a transcript the parser knows. The first lines of stderr show which lines were skipped and why.
- **"the privacy scan still found private items"**: the message lists each file and the kinds found. Write with `--force` into a scratch folder, run `scan` on it to see where, then fix with `--term` or `--allow`. Never pass `--force` for a file that will be shared without the user's say-so.
- **Video fails at "narrate"**: Kokoro is missing; run `$T/check_env.sh`, or use `--no-voice`.
- **The run's wall time is days long**: the session was resumed later. `stats.json` also has `activeMs`, which caps each idle gap at 5 minutes.
- **Huge sessions**: a 314 MB transcript took about 4 minutes and 4 GB of memory here (every rule runs twice: once to clean, once in the final scan). Long outputs are cut to `--max-output` characters (head and tail kept).
