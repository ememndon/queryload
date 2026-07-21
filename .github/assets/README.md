# Repository assets

Images referenced by the root `README.md`.

| File | Used for | Current |
|---|---|---|
| `homescreen.png` | The "Interface" section — the app in use | 1600 × 852 PNG |
| `queryload.jpg` | Clickable poster for the demo video | 1920 × 1080 JPEG |

**Filenames are case-sensitive on GitHub.** `Homescreen.png` and
`homescreen.png` are two different files there, even though Windows treats them
as one locally — so a capitalised upload silently leaves the README pointing at
nothing. Keep these names exactly as written when replacing them.

Match the extension to the actual file format too. A JPEG named `.png` usually
still renders, because browsers sniff the content, but it misleads any tool that
trusts the extension.

## homescreen.png

A capture of the running app with something on screen worth looking at — an
answer with visible `[n]` citation markers and the references rail populated.
An empty window undersells it.

Capture the window only, not the whole desktop, and avoid including real
documents: the demo corpus under `corpus/` is fictional and safe to show.

## queryload.png

The poster frame for the demo video at
<https://ememndon.com/videos/queryload.mp4>. GitHub cannot embed an externally
hosted MP4 as an inline player, so the README links this image to the video —
readers see the poster and click through.

A frame lifted from the video itself works well. A play-button overlay helps
signal that it is clickable.

## Adding more screenshots

Drop the file here and reference it as `.github/assets/<name>.png` from the root
README. Paths are relative to the repository root, not to this folder.
