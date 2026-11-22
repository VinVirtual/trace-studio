# Third-party assets

| File | What | Licence | Source |
|---|---|---|---|
| `assets/fonts/InstrumentSerif-Regular.ttf` | display serif (replay page headings, video headings) | SIL Open Font License 1.1 | github.com/google/fonts, `ofl/instrumentserif` (The Instrument Serif Project Authors) |
| `assets/fonts/Geist.ttf` | sans serif (video labels and captions) | SIL Open Font License 1.1 | github.com/vercel/geist-font (The Geist Project Authors) |
| `assets/fonts/JetBrainsMono.ttf` | monospace (video code and terminal panels) | SIL Open Font License 1.1 | github.com/google/fonts, `ofl/jetbrainsmono` (The JetBrains Mono Project Authors) |

The licence text and the copyright notices are in `assets/fonts/OFL.txt`. The replay page embeds Instrument Serif (turn off with `--no-fonts`); the video embeds all three.

The narration voice is made at render time by Kokoro (kokoro-onnx, Apache-2.0 model weights), which is not included in this repository. No voices or faces of real people are used.

Everything in `examples/` was made by this repository's own code: the session is fictional and scripted (see README.md), and every name, email, key and host name in it is made up.
