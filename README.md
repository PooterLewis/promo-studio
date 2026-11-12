# Promo Studio

A Windows desktop app for recording gameplay promo videos: screen, camera, mic, and game/Discord sound, straight into a built-in editor.

## Using it

- **Record:** choose a screen, tick *Record game and Discord sound*, turn on your camera and mic, then press **F9** to start and stop (it works while you're in the game). **F10** pauses.
- **Takes** save to `Videos\Promo Studio` while you record, so a crash never loses one.
- **Edit:** trim, split and reorder clips, add title cards, text and music, drag your camera anywhere.
- **Cutroom:** press **✦ Cutroom** in the top bar (opens your newest recording) or **✦ Make a video** on any take in the Library. Pick a style (Kyrn ad follows the promo rules), music from `Videos\Promo Studio\Music` and a brief, then **Send to Claude**: paste the copied message into Claude Code, which saves a `plan.json` into the request folder, and Cutroom loads it by itself, renders review frames back into the folder, and Claude checks them and revises (usually 2 rounds). It renders 3D titles, transitions, captions and the gameplay frame, and exports MP4 to the Library.
- **Several takes and hooks:** in Cutroom, **+ Add another take** (up to 4) lets Claude cut between recordings. Ask for hook variants in the brief ("3 hooks") and Claude writes 2-5 different openings on one shared body. Switch between them under the monitor; **Export N hook versions** saves one MP4 per hook (`Cutroom - <title> - <hook>.mp4`) for A/B posting.
- **Sound effects:** Cutroom uses real recorded sounds: 57 free CC0 starter sounds built in (whooshes, impacts, booms and braams, risers, reverse cymbals, glitches, clicks), plus anything you drop into `Videos\Promo Studio\Sounds`, subfolders and all. Files are sorted by name, so a whole library such as the free Sonniss GDC bundles works as is. Claude picks sounds by type or by name, and Cutroom lines them up on the cut and evens out their loudness.
- **Export:** 16:9, 9:16 (Shorts/TikTok) or 1:1 as MP4 (H.264). Exports also save to `Videos\Promo Studio`.

## Updates

The app checks GitHub Releases on start and every few hours, downloads new versions in the background, and shows **Restart to update**.

To ship a new version:

```
npm version patch        # bumps package.json and creates a tag like v0.1.1
git push --follow-tags   # the Release workflow builds the installer and publishes it
```

Updates only reach people when this repository is public, because the app downloads releases without a login.

## Developing

```
npm install
npm start
```

The editor is `app/index.html`; `app/cutroom.html` is generated from the Cutroom artifact source, so edit it there; `main.js` handles screen picking, system audio, hotkeys, files and updates.

The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time. Click **More info → Run anyway**.
