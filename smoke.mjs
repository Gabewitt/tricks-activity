import WebSocket from 'ws';
const names = ['Mamie','Papi','Rose','Jean'];
const clients = names.map((n,i)=>({ id:'u'+i, name:n, ws:new WebSocket('ws://localhost:3999/ws'), state:null }));
const wait = ms => new Promise(r=>setTimeout(r,ms));
for (const c of clients) {
  await new Promise(r=>c.ws.on('open',r));
  c.ws.on('message', m => { const d=JSON.parse(m); if(d.type==='state') c.state=d; else console.log('ERR', c.name, d.message); });
  c.ws.send(JSON.stringify({type:'join',instanceId:'call1',user:{id:c.id,name:c.name}}));
}
await wait(200);
clients[0].ws.send(JSON.stringify({type:'start'})); await wait(200);
for (let round=0; round<3; round++) {
  // bidding
  while (clients[0].state.game.phase==='bidding') {
    const g=clients[0].state.game; const c=clients.find(c=>c.id===g.turnId);
    const allowed=c.state.game.allowedBids; c.ws.send(JSON.stringify({type:'bid',bid:allowed[0]})); await wait(50);
  }
  while (clients[0].state.game.phase==='playing') {
    const g=clients[0].state.game; const c=clients.find(c=>c.id===g.turnId);
    c.ws.send(JSON.stringify({type:'play',cardId:c.state.game.legal[0]})); await wait(50);
  }
  const g=clients[0].state.game;
  console.log(`round ${g.round} (${g.cards} cards, trump ${g.trump}):`, g.players.map(p=>`${p.name} ${p.bid}/${p.won} => ${p.score}`).join(' | '));
  clients[0].ws.send(JSON.stringify({type:'nextRound'})); await wait(100);
}
console.log('other hands hidden:', clients[1].state.game.hand.length, 'vs opponents cardsLeft', clients[1].state.game.players.map(p=>p.cardsLeft));
process.exit(0);
