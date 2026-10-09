# Tricks — a Discord Activity

Four players join a voice call, launch the activity, and play Tricks on a shared table while they talk.

## How it's built

- `server/game.js` — the rules (game lengths, calling restriction, follow suit, scoring, scoreboard CSV). Pure logic, no Discord. `npm test` runs its tests.
- `server/index.js` — Express + WebSocket server. Swaps the Discord login code for a token, keeps one game room per voice call, holds each finished trick on the table for a moment, runs practice bots, and posts the final scores to Discord.
- `client/main.js` — starts inside Discord (Embedded App SDK), then hands over to `client/ui.js`, which draws the table.
- `client/preview.html` — the same table in a normal browser, without Discord (dev server only).

The table is drawn at a fixed size and scaled to fit, so it looks the same in a small call window, full screen, or on a tablet.

## 1. Create the Discord app (once)

1. Go to https://discord.com/developers/applications → **New Application** → name it "Tricks".
2. **OAuth2** page: copy the **Client ID** and **Client Secret** into a `.env` file (see `.env.example`). Add a redirect URL — `https://127.0.0.1` is fine, it's never used.
3. **Activities → Settings**: enable Activities, and under **Supported Platforms** tick **Web**, **iOS** and **Android** (iOS covers iPads).
4. **Activities → URL Mappings**: prefix `/`, target = your server's host (see steps 2 and 3).
5. **Installation**: Guild install, with the `applications.commands` and `bot` scopes and the permissions *View Channels*, *Send Messages* and *Attach Files*. Open the install link and add the app to the family's Discord server. (If you added it before the `bot` scope was there, just open the link again.)
6. **Bot** page: **Reset Token**, copy it into `.env` as `DISCORD_BOT_TOKEN`. This is only used to post the final scores.

## 2. Try it in a browser (no Discord needed)

```bash
npm install
cp .env.example .env    # fill in the Discord values; keep ALLOW_BOTS=1 for testing
npm run dev:server      # terminal 1
npm run dev:client      # terminal 2
```

Open http://localhost:5173/preview.html?name=Gabriel, press **Fill empty seats with practice bots**, and deal. Open more tabs with other names (`?name=Mamie`) to play several seats yourself.

## 3. Run it inside Discord from your laptop

Same two terminals as above, plus:

```bash
cloudflared tunnel --url http://localhost:5173   # terminal 3, prints https://xxx.trycloudflare.com
```

Put `xxx.trycloudflare.com` in **URL Mappings** (prefix `/`). The address changes every time you restart cloudflared. In Discord: join a voice channel, click the rocket (Activities) button, pick Tricks.

## 4. Host it 24/7 (Render)

1. Push this folder to GitHub.
2. Render web service from the repo. Build command `npm install && npm run build`, start command `npm start`.
3. Environment variables: `VITE_DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`. Optional: `SCORES_CHANNEL_ID`, `ALLOW_BOTS=1`.
4. Set the Render host (e.g. `tricks-activity.onrender.com`) as the root URL mapping.

Render's free tier sleeps after ~15 minutes idle; the first launch afterwards takes up to a minute.

## Final scores in Discord

When a game ends, the server posts the standings plus the full scoreboard as a CSV file (one row per round: cards, trump, total called, over/under, and each player's call, tricks won, points and running total). By default it goes to the text chat of the voice channel you played in. To collect every game in one place instead, create a text channel such as `#tricks-scores`, right-click it → **Copy Channel ID** (needs Developer Mode in Discord's Advanced settings), and set `SCORES_CHANNEL_ID` to that number.

If `DISCORD_BOT_TOKEN` isn't set, nothing is posted and the game still works.

## What the grandparents do each time

1. Open Discord (computer or iPad), join the voice channel.
2. Click the Activities (rocket) button, choose **Tricks**.
3. The first person in is the host: they choose **Full game** or **Half game** and press **Deal the first round** once four people are seated.

Seating order in the lobby = clockwise play order. If someone's connection drops, they relaunch the activity and get their seat and hand back.

## Rules encoded

- Game length: **Full** = 1 up to 12 cards, four 13-card rounds, 12 back down to 1, four more 13s (32 rounds). **Half** = 1 up to 12, then four 13s (16 rounds). Edit `SCHEDULES` in `server/game.js` to change them.
- Dealer rotates each round, calls first and leads the first trick; the trick winner leads the next.
- Except in the very first round of the game, the last caller may not make the total equal the cards dealt.
- Must follow suit if able; highest trump wins, otherwise highest card of the led suit. Aces high.
- 13-card rounds have no trump.
- Exact call: 10 + 10 × call. Miss: −(10 + 10 × amount missed by).
- Hands are sorted spades, hearts, clubs, diamonds, lowest to highest (2 up to ace) within each suit.

## Settings (`.env` / Render environment)

| Variable | What it does |
| --- | --- |
| `VITE_DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord login (required) |
| `DISCORD_BOT_TOKEN` | Lets the server post final scores (optional) |
| `SCORES_CHANNEL_ID` | Post scores to this channel instead of the call's chat (optional) |
| `ALLOW_BOTS=1` | Shows the practice-bot button in the lobby |
| `TRICK_PAUSE_MS` | How long a finished trick stays visible (default 2600) |
