// Browser preview without Discord (dev server only):
//   http://localhost:5173/preview.html?name=Gabriel&table=test
// Open it in several tabs with different names to fill the seats, or start
// the server with ALLOW_BOTS=1 and use "Fill empty seats with practice bots".
import { connectSocket } from './ui.js';

const params = new URLSearchParams(location.search);
const name = params.get('name') || 'Guest';
const table = params.get('table') || 'preview';
let id = sessionStorage.getItem('tricks-preview-id');
if (!id) {
  id = `preview-${Math.random().toString(36).slice(2, 10)}`;
  sessionStorage.setItem('tricks-preview-id', id);
}
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
connectSocket(`${proto}://${location.host}/ws`, { type: 'join', instanceId: table, user: { id, name } });
