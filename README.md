# Promo Studio

A Windows desktop app for recording gameplay promo videos: screen, camera, mic, and game/Discord sound, straight into a built-in editor.

## Using it

- **Record:** choose a screen, tick *Record game and Discord sound*, turn on your camera and mic, then press **F9** to start and stop (it works while you're in the game). **F10** pauses.
- **Takes** save to `Videos\Promo Studio` while you record, so a crash never loses one.
- **Edit:** trim, split and reorder clips, add title cards, text and music, drag your camera anywhere.
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

The editor is `app/index.html`; `main.js` handles screen picking, system audio, hotkeys, files and updates.

The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time. Click **More info → Run anyway**.
