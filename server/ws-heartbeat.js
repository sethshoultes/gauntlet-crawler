// WebSocket liveness sweep, extracted so it can be unit tested with fake sockets. Terminates any
// client that didn't pong since the last sweep and pings everyone else — must keep iterating past
// a dead socket instead of bailing out (a bare `return` inside the loop would abort the whole
// sweep on the first dead client and leave the rest never pinged).
export function heartbeat(clients) {
  for (const ws of clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}
