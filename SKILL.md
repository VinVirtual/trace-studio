---
name: trace-studio
description: Turn an AI agent run into a replay you can watch and share. Reads a Claude Code session transcript (~/.claude/projects/*/*.jsonl) or an Anthropic or OpenAI message log, anonymises it first (absolute paths, the home folder, user and host names, emails, API keys and tokens, IP addresses, plus any words you list), then makes a single-file HTML timeline replay (scrubbable, play button, tool calls with collapsed outputs, inline diffs of every file edit, works offline), a 30 to 60 second narrated summary video of how the agent solved the task, and a stats JSON (time, tool calls, failures, files and lines changed, tokens). Use whenever the user wants to replay, share, show, review, debug, document or demo an agent session or a coding-assistant run; asks "what did the agent do", "share this Claude Code session", "turn my transcript into a video", "visualise the tool calls", "make a replay", "export the session as HTML", "anonymise this transcript", "session stats", "how many tokens or tool calls did it use"; or wants a post-mortem of a run that went wrong.
---

# trace-studio

Transcript → **anonymise** → parse → **replay.html** + **stats.json** + **story.json** → **summary.mp4**. Plain Node 18+ for everything except the video, which also uses ffmpeg, Playwright with a browser, and Kokoro (local text to speech). Nothing is uploaded anywhere.

Skill folder: `~/.claude/skills/trace-studio/` (written `$T` below). Every command is `$T/trace-studio <command>`; `$T/trace-studio help` lists them.

## Workflow

1. **Find the transcript.** `$T/trace-studio list` shows Claude Code sessions on this machine, newest first (date, size, path). `latest` means the newest one, which is usually the session you are in right now; ask the user which run they mean if it is not obvious. Other inputs: an Anthropic Messages log, an OpenAI Chat Completions log or a list of OpenAI Responses items, as `.json` or `.jsonl` (README.md, "Inputs").
2. **Ask about private words.** The anonymiser catches things with a recognisable shape. It cannot know a client's name, a product code name or a colleague's name. Ask: "Are there names of clients, products or people in this session that must not appear?" Pass each with `--term NAME` (or `redact.terms` in a config file). Keep a value with `--allow TEXT`.
3. **Build:** `$T/trace-studio build <transcript> --out <dir> [--term X]...`. It writes `redaction.json`, `stats.json`, `replay.html`, `story.json`, then renders `summary.mp4` with a poster and captions. Add `--no-video` for the page and stats only (seconds, no extra tools). Every output is scanned for anything private before it is written; if the scan finds something, nothing is written and the command says what kind of item it was.
4. **Look at what you made before handing it over.**
   - Open `replay.html` in a browser (with Playwright, take a screenshot and Read it). Check the title, a tool call with its output open, and a diff.
   - Read `redaction.json`: counts per kind. Zero home paths on a coding session is suspicious: check the page.
   - Search the page for the user's real name, company and project names: `$T/trace-studio scan <file> --term NAME` exits 1 when it finds one.
   - For the video, Read the poster (`summary-poster.jpg`) and a few frames pulled with ffmpeg (`-vf fps=1/6,tile=2x4`) to check every scene. You cannot hear the audio; check the duration and loudness with `ffmpeg -i summary.mp4 -af volumedetect -f null -` and say that you did.
5. **Improve the narration if asked.** `story.json` holds one `say` line per scene, filled in from counted facts. The first scene says only that the agent was given a task. You may rewrite lines in plain words (for example, what the task was), then run `$T/trace-studio video <dir>/story.json`. Only state what the transcript shows. Never claim the agent "fixed" something unless a later step shows it working, and never invent numbers.
6. **Report back:** the paths, the step and tool counts, how many items were replaced and of which kinds, anything the scan flagged, and the reminder below.

Always tell the user: **"The anonymiser removes what has a recognisable shape. Read the page before you share it."** Thinking text is left out unless they ask for `--thinking`.

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

Options: `--config FILE`, `--allow TEXT`, `--term TEXT` (both repeatable), `--keep-paths`, `--keep-ips`, `--thinking`, `--max-output N` (characters kept per tool output, default 12000), `--title TEXT`, `--no-fonts`, `--voice NAME` (Kokoro voice, default `af_heart`), `--no-voice` (silent, timed by word count), `--format landscape|square|vertical`, `--force` (write even when the final scan flags something; only when the user has looked and agrees).

Config file (`--config trace-studio.json`):

```json
{ "redact": { "terms": ["Initech", "Project Falcon"], "allow": ["support@example.com", "/^\\/opt\\/tools\\//"], "keepIps": false },
  "maxOutput": 12000, "thinking": false, "title": "Fixing the CSV import", "video": { "format": "vertical", "voice": "bf_emma" } }
```

## What the anonymiser does

Replaced, in this order: values of secret-named environment variables of this shell; API keys and tokens (OpenAI and Anthropic `sk-`, AWS `AKIA`/`ASIA` ids and secret keys in assignments, GitHub `ghp_`/`gho_`/`github_pat_`, GitLab, Slack, Google, Stripe, Hugging Face, npm, JWTs, private key blocks, `Bearer` headers, `password=` style pairs (any 8+ character value after a password name), passwords in URLs); emails; shell prompts (`me@box:~$`); the project folder (shown as `<project>`, paths inside it become relative); any user's home folder (`/home/x`, `/Users/x`, `C:\Users\x`, `/root` become `~`); other absolute paths under private folders such as `/tmp`, `/var`, `/mnt`, `/opt` (shortened to `/…/file`); this machine's user name and host name, and user names seen in home folders anywhere in the log; internal host names (`.local`, `.internal`, `.lan`, `.corp`); IPv4 addresses except loopback; every `--term`. Fields that identify an account or request (account and organisation ids, request ids, thinking signatures) are dropped, and inline images are removed.

## Troubleshooting

- **"no steps found"**: the file is not a transcript the parser knows. The first lines of stderr show which lines were skipped and why.
- **"the privacy scan still found N item(s)"**: usually an allowed value in an unusual spot, or a name the user listed. Run `scan` on the output written with `--force` into a scratch folder to see the kinds, then add `--term` or `--allow`. Never pass `--force` for a file that will be shared without the user's say-so.
- **Video fails at "narrate"**: Kokoro is missing; run `$T/check_env.sh`, or use `--no-voice`.
- **The run's wall time is days long**: the session was resumed later. `stats.json` also has `activeMs`, which caps each idle gap at 5 minutes.
- **Huge sessions**: a 314 MB transcript took 35 seconds and 1.2 GB of memory here. Long outputs are cut to `--max-output` characters (head and tail kept).
