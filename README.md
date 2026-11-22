<p align="center"><img src="docs/summary-preview.webp" width="640" height="360" alt="A few seconds of the example summary video: a terminal panel with a failing test run, then a green badge saying the same command ran clean at step 9"></p>

# trace-studio

[![test](https://github.com/VinVirtual/trace-studio/actions/workflows/test.yml/badge.svg)](https://github.com/VinVirtual/trace-studio/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn an AI agent run into a replay you can watch and share.

Give it a Claude Code session file, or an Anthropic or OpenAI message log. It removes private details first, then makes three things:

1. **`replay.html`**: one file you can send or attach. A timeline of the run with a play button, a scrubber, every tool call with its output folded away, and an inline diff of every file edit. It works offline and loads nothing from the network.
2. **`summary.mp4`**: a 30 to 60 second narrated video of how the agent solved the task, with captions. Drawn on a canvas in headless Chrome and voiced locally with Kokoro.
3. **`stats.json`**: time taken, steps, tool calls and failures, files and lines changed, tokens when the log has them, and what the anonymiser replaced.

> **Redaction is best-effort pattern matching.** It removes what has a recognisable shape (keys, emails, paths, names it can learn from the log) and checks every output again before writing it, but it cannot understand what it reads. **Always open `replay.html` and skim it before you share it**, and pass the names of your organisation, repositories, clients and colleagues with `--term NAME` so they are replaced everywhere.

It is packaged as a [Claude Code](https://claude.com/claude-code) skill (`SKILL.md` tells the assistant how to use it) and works by hand from the command line. Plain Node.js for the page and stats; no npm packages to install.

![The replay page for the example run: the title, the play bar with one coloured block per step, the person's request, the agent's reply, tool calls with durations and a failed test run marked in red, and a side panel with the time, tool counts, files changed and what was anonymised](docs/replay.jpg)

## The example

[`examples/wordfreq/`](examples/wordfreq/) is a complete worked example. Open [`out/replay.html`](examples/wordfreq/out/replay.html) in a browser, or watch [`out/summary.mp4`](examples/wordfreq/out/summary.mp4) (51.6 seconds, 1280×720, 3.3 MB).

The session is **fictional and scripted**. No model was called. [`make-session.mjs`](examples/wordfreq/make-session.mjs) plays an agent fixing a word counter: it writes a tiny project into a throwaway folder, really runs the tests (they really fail, twice), really applies three edits, and records every step in the Claude Code session format. The agent's sentences are written by hand. Tool durations are measured; the pauses while the "model" thinks are fixed numbers, and the token counts are estimates (characters ÷ 4). The throwaway folder's real path is swapped for a made-up one (`/home/dana/code/wordfreq`), and the made-up project contains made-up secrets (an email, an API key, a GitHub token, an internal host name and an IP address) so you can see them disappear: [`out/redaction.json`](examples/wordfreq/out/redaction.json) counts 56 replacements.

```bash
node examples/wordfreq/make-session.mjs            # writes examples/wordfreq/session.jsonl
./trace-studio build examples/wordfreq/session.jsonl --out examples/wordfreq/out --allow wordfreq
```

By default the project's folder name is hidden everywhere, because it often names a client. Here it is the name of the code being fixed (`wordFreq`), so the example keeps it with `--allow wordfreq`; without that, 49 more words are replaced.

On this machine (16 cores, no GPU) the build took about 27 seconds: 8 scenes of narration, then 1,549 frames drawn in three browser pages in 12 seconds.

## Install

```bash
git clone https://github.com/VinVirtual/trace-studio ~/.claude/skills/trace-studio
~/.claude/skills/trace-studio/check_env.sh
```

| Needed | For |
|---|---|
| Node.js 18 or newer | everything |
| ffmpeg (on PATH, or the `imageio-ffmpeg` Python package) | the video |
| Playwright (`npm i -g playwright-core`) and Chrome or Chromium | the video |
| Python with `kokoro-onnx`, `soundfile`, `numpy`, and the Kokoro model files (about 340 MB) in `~/kokoro` | the narration (`--no-voice` works without) |

`check_env.sh` says exactly what to run for anything missing.

## Quick start

```bash
T=~/.claude/skills/trace-studio
$T/trace-studio list                                   # your Claude Code sessions, newest first
$T/trace-studio build latest --out run-replay --term "Client Name"
$T/trace-studio build path/to/log.json --out run-replay --no-video   # page and stats only, in seconds
```

`build` writes `redaction.json`, `stats.json`, `replay.html`, `story.json`, `summary.mp4`, `summary-poster.jpg` and `summary.vtt`. `story.json` is a working file: besides the narration it keeps salted hashes of the names learned from the log, so a later `video` can check your edits for them. Short names can be guessed from such hashes, so share the page and the video, not `story.json`. To change what the narrator says, edit the `say` lines in `story.json` and run `$T/trace-studio video run-replay/story.json`.

Other commands: `html`, `stats`, `story`, `video` (one output each), `redact` (an anonymised copy of the transcript), `scan` (look for private items in any file), `check`, `test`. `trace-studio help` lists every option.

## How it works

1. **Read.** JSON Lines or one JSON document. A line that is not valid JSON becomes a warning with its line number (a cut-off last line is reported as "the session may still be running"); the rest of the file is still read.
2. **Anonymise, first.** Each record is cleaned the moment it is parsed, before anything else looks at it: string values and object keys alike. See "What is replaced" below. The report keeps counts and line numbers, never the values.
3. **Parse.** Records become steps: the person's messages, the agent's replies, thinking (text left out by default), tool calls matched to their results by id, notes (interruptions, compaction). Times come from timestamps; tool durations are result time minus call time. Token usage is counted once per model message (Claude Code repeats it on every content block). File edits come from Claude Code's stored patches, or from the call's old and new text with a Myers line diff.
4. **Stats.** Counted from the steps. A value the log does not have is `null`, not zero.
5. **Replay page.** The styles, the script, one display font and the data go into one HTML file. The data sits in a `<script type="application/json">` block with `<`, `>` and `&` escaped, and the page builds every element with `textContent`, so a tool output that contains `<script>` shows as text. A content security policy allows only the page's own script and style (by hash) and blocks all network access.
6. **Story.** Scenes chosen from what the run contains (title, numbers, timeline of phases, tools, the first failure, the biggest edit, the end result) with one narration line each, filled in from counted facts.
7. **Video.** Kokoro speaks each line; the scene lengths follow the voice. A canvas page draws each frame as a pure function of time, three pages draw in parallel, and ffmpeg encodes H.264 with AAC audio, a quiet pad under the voice, a poster and WebVTT captions.
8. **Last check.** Every text output is scanned before any is written: the same patterns again (after undoing JSON escapes, twice for JSON inside JSON), plus looser checks of its own (long random-looking strings near secret words, any `-----BEGIN` block that is not public, credentials in URLs). If anything is found, nothing is written. Outputs of an earlier run in the same folder are removed, files are written through a temporary name and renamed, and an output path that is a symbolic link is refused. `video` scans the story before drawing, because a story may have been edited by hand. The MP4 and the poster are drawn only from the scanned story; they are not scanned themselves.

### Inputs

| Format | Shape |
|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl`: one record per line (`user`, `assistant`, `system`, titles, and metadata records, which are skipped) |
| Anthropic Messages | `{ "messages": [...] }`, a list of messages, or one message per line; `text`, `thinking`, `tool_use`, `tool_result` blocks; response objects with `usage` |
| OpenAI Chat Completions | `{ "messages": [...] }` or a list; `tool_calls` with JSON `arguments`, `role: "tool"` replies, legacy `function_call` |
| OpenAI Responses | items of type `message`, `function_call`, `function_call_output`, `reasoning` |

### What is replaced

Terminal colour codes and invisible characters (zero-width spaces, soft hyphens) are removed first, so they cannot split a key or a path.

| Kind | Examples | Becomes |
|---|---|---|
| keys and tokens | `sk-…`, Stripe `sk_`/`rk_`/`whsec_`, `AKIA…`, `ghp_…`, `github_pat_…`, GitLab, Slack tokens and webhook URLs, Discord bot tokens and webhooks, Telegram bot tokens, Google, Hugging Face, npm, SendGrid, Twilio, Supabase, DigitalOcean, Replicate, Groq, Mailgun, JWTs, PEM/OpenSSH/PGP private key blocks, keys wrapped over lines, Azure `AccountKey=`, `Bearer …`, `Cookie:`/`Set-Cookie:` and `curl -b`, `scheme://user:pass@` (also `redis://:pass@`), secrets in query strings (`?key=`, `sig=`, `X-Amz-Signature=`), a bare 40-character AWS secret key near "aws" or "secret", base64 text that decodes to any of these, values of secret-named environment variables of this shell | `[redacted-key]` |
| command-line passwords | `--password x`, `mysql -px`, `curl -u user:pass`, `sshpass -p`, `redis-cli -a`, `openssl -k` / `-passin pass:`, `htpasswd -b`, `echo user:pw \| chpasswd`, `.pgpass` lines | `[redacted-key]` |
| secret-named values | also when escaped inside JSON, URL-encoded (`password%3D…`), split over two lines (`- name: DB_PASSWORD` / `value: x`), as `{"name": …, "value": …}` pairs, lists, `<password>x</password>`, Markdown table rows, and JSON numbers under keys like `pin`. Any `NAME=value` or `name: value` whose name contains password, pwd, secret, token, api key, private key, access key, credential, auth or ends in `_KEY` (`DB_PASSWORD`, `SECRET_KEY_BASE`, `X-Api-Key`, `_authToken`). Password names: any value of 3+ characters. Others: values that look like secrets (digits, mixed case, symbols or length) | `[redacted-key]` |
| emails | `dana@example.com`, `"a b"@example.com`, `bob@bücher.example`, `bob%40example.com`, `bob\u0040…`, full-width `＠`, `dana&#64;…`, `dana [at] example [dot] com` | `[redacted-email]` |
| personal numbers | payment card numbers (Luhn-checked, spaced, dashed, bare or JSON numbers), US social security numbers, IBANs (checksum), phone numbers (`+44 20 …`, `(415) 555-…`) | `[redacted-number]` |
| project folder | the session's working folder | `<project>` (paths inside it are shown relative) |
| project name | the folder's name and the folders between it and home, anywhere (`git clone …/acme-portal.git`) | `[redacted]` (`--allow NAME` keeps one; `--keep-project-name` keeps all) |
| home folders | `/home/x`, `/Users/x`, `/Users/Bob Smith/`, `/Volumes/Disk/Users/x`, `/mnt/c/Users/x`, `C:\Users\x`, `C:\\Users\\x`, `%2Fhome%2Fx`, `/root`, also after `-I`, `=`, `:`, in `file://` and `vscode-remote://` addresses and PATH lists | `~` |
| other paths | UNC paths (`\\server\share`, `//server/share`); absolute paths under `/tmp`, `/var`, `/opt`, `/mnt`, `/srv`, `/data`, … | `\\[redacted-host]\…\last`, `/…/last-part` |
| users and hosts | this machine's user and host names; names the log gives away (home folders, `whoami`, `id`, `echo $USER` output, `/etc/passwd` lines with the full name, git `Author:`/`Co-authored-by:` lines and `user.name`); shell prompts (`me@box:~$`, zsh `me@box ~ %`, `[me@box dir]$`), `ssh user@host` targets, `*.local`, `*.internal`, `*.lan`, `*.corp`. Names of 4+ characters are also found inside longer words (`casey_test`, `caseybox2`) | `[redacted-user]`, `[redacted-host]` |
| network addresses | IPv4 except `127.0.0.1` and `0.0.0.0`, IPv6, MAC addresses | `[redacted-ip]` |
| your words | every `--term`, anywhere in a word, any case (terms under 4 characters as whole words) | `[redacted]` |

System paths (`/usr`, `/bin`, `/etc`, `/dev`), URLs and code such as `password = getPassword()` are kept. App and folder names in system paths that may be private (an in-house tool under `/opt`, `../billing-internal`) are listed on the terminal as a hint, not replaced. Bots (`dependabot[bot]`, `github-actions[bot]`) and `Claude` are kept as author names; `--allow NAME` keeps others. `--allow` keeps a value; `--keep-paths` and `--keep-ips` switch those kinds off.

## Limits

Read these before you share anything.

- **Redaction is best-effort pattern matching. Review `replay.html` before sharing it.** Add the names of your organisation, repositories, clients and colleagues with `--term`.
- **The anonymiser matches shapes, not meaning.** It is cautious on purpose: user and project names are replaced inside other words too, so a user called `mark` also turns `markdown` into `[redacted-user]down` (names under 4 characters are matched as whole words only). It cannot know that "Falcon" is a secret project, that a sentence describes a client, or that a pasted document is confidential. List such words with `--term`, and read the page before sharing it.
- **Unusual secrets slip through.** Host names on ordinary public domains (`db.example.com`) are kept. A password in a sentence with no secret word near it, a key in a format not listed above, a private key without its header line, base64-encoded credentials. The scan at the end reruns every rule and adds a few looser checks, so it misses most of what the rules miss. When it blocks a write it names the rule and the line; a story edited by hand is checked against the names learned from the log through salted hashes, so `story.json` never holds them.
- **The narration is filled in from counts, not understood.** It says "a command failed" and "the same command ran without an error four steps later"; it does not know why. It never says what the task was in its own words: the title scene shows the person's first message instead. Edit `story.json` if you want more.
- **"Biggest edit" means most lines changed**, which is not always the most important change.
- **Times come from the log.** Wall time includes every pause, even days between a session and its resumption (`activeMs` caps idle gaps at 5 minutes). A tool's duration is the gap between its call and its result being written.
- **Thinking text is left out by default.** Claude Code often stores it empty anyway.
- **Images and attachments are not shown**, only marked.
- Other agent formats (LangChain traces, OpenTelemetry spans, Cursor or Aider logs) are not read.
- The video is a summary of counts and moments, not a screen recording.
- Tested on Linux with Node 24 (the CI workflow runs Node 22). The page was checked in Chromium only.

## Development

```bash
./trace-studio test     # 111 tests with node --test
```

The tests cover the anonymiser (every key format listed above, emails, home folders on three systems, paths, user and host names, IPs, terms, the allow list, hostile input that would make slow regular expressions hang, and one regression test for each finding of an independent security review), the parser (Claude Code records, Anthropic and OpenAI shapes, malformed and truncated lines, duplicates, orphaned results, usage counting, every kind of edit), diffs, the page (script injection in tool output, the security policy, no network loads, and in a real browser when Playwright is present: payloads show as text, nothing runs, the player moves), stats, the story and video timing, the command line in throwaway folders, and a 30,000-record session. The browser test is skipped on GitHub's runner, which has no Playwright; nothing else needs ffmpeg, a browser or Kokoro.

## Licence

MIT, see [`LICENSE`](LICENSE). Fonts are under the SIL Open Font License; see [`ASSETS.md`](ASSETS.md).
