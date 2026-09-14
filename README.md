# Tricks — a Discord Activity

Four players join a voice call, launch the activity, and play Tricks on a shared table while they talk.

## How it's built

- `server/game.js` — the rules (deal schedule, bidding restriction, follow-suit, scoring). Pure logic, no Discord. `npm test` runs its tests.
- `server/index.js` — Express + WebSocket server. Swaps the Discord OAuth code for a token and keeps one game room per voice call.
- `client/` — the table UI, loaded inside Discord via the Embedded App SDK.

The round schedule lives in one list (`DEFAULT_SCHEDULE` in `server/game.js`). Change it there if the family plays a different length.

## 1. Create the Discord app (once)

1. Go to https://discord.com/developers/applications → **New Application** → name it "Tricks".
2. **OAuth2** page: copy the **Client ID** and **Client Secret** into a `.env` file (see `.env.example`). Add a redirect URL — `https://127.0.0.1` is fine, it's never used.
3. **Activities → Getting Started**: enable Activities.
4. **Activities → URL Mappings**: you'll fill this in with your server URL in step 2 or 3.
5. **Installation**: set install context to *Guild* and use the generated install link to add the app to the family's Discord server (create one if they don't have one).

## 2. Run it on your laptop (for testing)

```bash
npm install
cp .env.example .env   # fill in the two Discord values
npm run dev:server     # terminal 1
npm run dev:client     # terminal 2
cloudflared tunnel --url http://localhost:5173   # terminal 3, prints a https://xxx.trycloudflare.com URL
```

Put that trycloudflare URL in **URL Mappings** as the root mapping (`/` → `xxx.trycloudflare.com`). Then in Discord, join a voice channel, click the rocket/activities button, and pick Tricks. Also enable *Developer Mode* in your Discord settings so unreleased activities show up.

To test alone, open Discord in four browser profiles/accounts, or temporarily change `room.players.length < 4` in `server/index.js`.

## 3. Host it 24/7 (so the grandparents never need you)

Any Node host works. Railway or Render is the least effort:

1. Push this folder to a GitHub repo.
2. On Railway/Render, create a new web service from the repo. Build command `npm install && npm run build`, start command `npm start`. Add the three `.env` values as environment variables.
3. Take the service's public URL (e.g. `tricks.up.railway.app`) and set it as the root URL mapping in the Developer Portal.

Cost is roughly $5/month or free tier; the app idles when nobody is playing.

## What the grandparents do each time

1. Open Discord, join the voice channel.
2. Click the activities (rocket) button, choose **Tricks**.
3. First person in is the host and presses *Deal the first round* once four people are seated.

Seating order in the lobby = clockwise play order. If someone's connection drops, they can just relaunch the activity and they get their seat and hand back.

## Rules encoded

- Dealer calls first and leads the first trick; the trick winner leads the next. Dealer rotates each round.
- After the 1-card round, the last caller may not make the total equal to the number of cards dealt.
- Must follow suit if able; highest trump wins, otherwise highest card of the led suit. Aces high.
- 13-card rounds have no trump.
- Exact call: 10 + 10 × call. Miss: −(10 + 10 × amount missed by).
- Schedule: 1 card up to 13 cards (13 rounds); the 13-card round has no trump.
