// Entry point inside Discord: sign in through the Embedded App SDK, then hand
// over to the table UI (ui.js). For testing in a normal browser without
// Discord, open /preview.html on the dev server instead.
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { connectSocket, showError } from './ui.js';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

async function connectDiscord() {
  const sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();

  // Phones and tablets: keep the table sideways, it's laid out for landscape.
  if (sdk.platform === 'mobile') {
    sdk.commands
      .setOrientationLockState({ lock_state: 3, picture_in_picture_lock_state: 3, grid_lock_state: 3 })
      .catch(() => {});
  }

  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });
  const res = await fetch('/.proxy/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { access_token } = await res.json();
  const auth = await sdk.commands.authenticate({ access_token });
  return {
    instanceId: sdk.instanceId,
    channelId: sdk.channelId,
    user: { id: auth.user.id, name: auth.user.global_name || auth.user.username },
  };
}

(async () => {
  try {
    const session = await connectDiscord();
    connectSocket(`wss://${location.host}/.proxy/ws`, { type: 'join', ...session });
  } catch (e) {
    showError(`Could not connect to Discord: ${e.message}`);
  }
})();
