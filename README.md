# Tug of War: Rider Gala Gaming Village

A live crowd game. Riders scan a QR code, pick a team and tap their phone as fast as they can. The big screen shows the rope moving. Teams are scored by **taps per player**, so a smaller team can still beat a bigger one.

- **Players** open `https://your-site/` on their phones.
- **The host** opens `https://your-site/host` on the big screen and types the PIN. The host starts each round.
- The game runs **on the server** (one shared room), so there are no accounts, no sign-in and no player limit in the code.

## 1. Try it on your own computer (2 minutes)

You need Node.js 18 or newer. Nothing else to install: the one dependency (`ws`) is already in this folder.

```
HOST_PIN=1234 node server.js
```

(On Windows PowerShell: `$env:HOST_PIN="1234"; node server.js`)

1. Open the host screen using your computer's **network address**, for example `http://192.168.1.20:3000/host`, not `localhost`. The QR code on screen is built from the address you opened, so `localhost` would give phones a link that cannot work.
2. Enter the PIN.
3. Scan the QR code with a phone on the same Wi-Fi, pick a team, then press **Start round** on the host.

If you do not set `HOST_PIN`, the server picks a random one and prints it in the terminal.

## 2. Put it on a website

It needs a host that **runs Node.js 18+ and allows WebSockets**. Static-only hosting (GitHub Pages, Netlify, S3, plain web hosting) will not work. Examples that do: Render, Railway, Fly.io, any Linux server or VM, any Docker host, or an internal platform if IT confirms WebSocket support.

Settings (environment variables):

| Name | What it does | Default |
|---|---|---|
| `HOST_PIN` | PIN for the host screen. **Set this.** | random, printed at start |
| `PORT` | Port to listen on (most platforms set this for you) | `3000` |
| `ALLOWED_ORIGINS` | Optional. Comma-separated list such as `https://games.example.com`. If set, only pages from these origins can connect. | any |

**Docker**

```
docker build -t tug-of-war .
docker run -p 3000:3000 -e HOST_PIN=1234 tug-of-war
```

**Without Docker:** copy this folder to the server, run `node server.js`, and keep it running with your platform's process manager (for example systemd or pm2).

**Rules to follow**

- Run exactly **one** instance. The game state lives in memory, so two instances would be two separate games.
- Use **HTTPS**. The app switches to `wss://` automatically.
- If you put nginx (or another proxy) in front, it must pass WebSocket upgrades:

```
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
}
```

- A health check is available at `/healthz` (returns `ok`).
- Restarting the server resets the series score and the results log. Export the CSV first (host screen, Pilot tools).

## 3. Games menu and the how-to video

Riders now open the site on a **games menu**. Tapping **Tug of War** pops up a short portrait how-to-play video (about 40 seconds, with music and narration). The video ends with a **Let's play** button that goes to the team picker. A **Skip** button is on screen the whole time, and **Sound on/off** is on the video. After picking a team, the link **Watch how to play** opens the video again.

- The video file is `public/media/tug-howto.mp4` (720 x 1280, H.264 and AAC, about 5 MB), with a poster image next to it. To use a different video, replace the file with one of the same name.
- The server answers video **range requests**. iPhones and Safari will not play a video without this, so keep it if you change the server, and check that any proxy or CDN in front passes range requests through.
- If the video cannot load, the game skips it and goes straight to the team picker, so a missing file never blocks play.
- The video downloads only when a rider opens it (not on page load), which keeps the first load light on mobile data.
- The same MP4 can be shared on its own (for example on WhatsApp or a training deck).
- The words in the video are on screen as large text, so it still works with the sound off.
- The narration is a synthetic voice, not a recording of a person. Music is generated, not licensed. If you record a real voice-over later, the video needs to be re-exported with it.

## 4. Running a pilot

1. Deploy, open `/host`, enter the PIN, and open **Pilot tools** (button on the host screen, or press `P`).
2. Ask 5 to 20 colleagues to scan the QR code and tap. Watch the live numbers: players, taps per second, messages, server tick time.
3. Use **Dry run** to add simulated players (up to 300 per team in the panel) and see how the rope and screen behave with a big crowd. Simulated players cost the server almost nothing, so they do not test the network.
4. After rounds, press **Export results (CSV)**.

### Load test (the real network test)

```
node loadtest.js --url wss://your-site/ws --pin 1234 --players 500 --rate 5 --seconds 30
```

This opens hundreds of fake phones, starts a round and taps. It prints how many connected, how busy the server was and a plain verdict. Run it from a different computer than the server for a fair result.

Our test on a small shared single-core machine, with the load generator running on the same machine: 2,000 fake phones tapping 5 times a second connected without failures, and the server's game step took 0.3 ms on average (worst 28 ms; the budget is 100 ms). One phone receives about 1 KB per second. **That does not include the venue network.** At a live event the weak point is usually Wi-Fi: one access point handles only a limited number of devices, so ask riders to use mobile data and test at the venue.

## 5. How the game is scored

- Phones send their tap counts in small batches (about 8 messages per second).
- Every 100 ms the server works out each team's **taps per player per second**, smooths it, and moves the rope toward the team that is pulling harder per player.
- Taps above 12 per second per player are ignored (limits auto-clickers).
- A round ends when the flag reaches a team's line, or when time runs out. If time runs out, the team ahead wins.
- To change the feel, edit the constants at the top of `server.js`: `GAIN` (how fast the rope moves), `REF_RATE` (taps per second that count as full power), `MAX_RATE` (cap).

## 6. Host screen controls

Start round, Next round, Sound, Full screen, Pilot tools, team names (click the name boxes in the lobby), round length (30, 45 or 60 seconds), Reset series. Keyboard: `Space` or `Enter` starts the next step, `P` opens Pilot tools, `F` toggles full screen.

## 7. Files

```
server.js         the server and the game engine
loadtest.js       load test tool
public/           the web app (index.html, styles.css, app.js, fonts, logo)
public/media/     the how-to video and its poster image
Dockerfile        optional container build
node_modules/ws   the only dependency, included
```

## 8. Brand and licences

Colours, Poppins type, the orange accent bar and the tilted talabat logo follow the Talabat brand guide. The talabat logo is Talabat's own asset. Poppins is licensed under the SIL Open Font License. `qrcode.js` (public/vendor) and `ws` are MIT licensed.

## 9. What has and has not been tested

Tested: the full flow in a real browser against this server (PIN, five phones, rejoin after a page reload, a full round, results, CSV, simulated crowd, practice mode) and the load test above.
The how-to popup (open, play, mute, finish, continue, skip, reopen, missing video, reload) was tested in a real browser. That test browser cannot decode MP4, so the popup logic was checked with a small WebM stand-in, and the real MP4 was checked with ffmpeg and by looking at frames from the finished file. The server's range-request handling was checked directly.
Not tested: real phones (including iPhone video playback), a real venue network, or the platform you deploy to. Run a pilot there before the event.

Phone text is English only for now.
