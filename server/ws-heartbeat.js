// WebSocket liveness sweep, extracted so it can be unit tested with fake sockets. Terminates any
// client that didn't pong since the last sweep and pings everyone else — must keep iterating past
// a dead socket instead of bailing out (a bare `return` inside the loop would abort the whole
// sweep on the first dead client and leave the rest never pinged).
export function heartbeat(clients) {
  for (const ws of clients) {
    // A socket can transition to CLOSING/CLOSED between the liveness check above and the
    // terminate()/ping() call below, which can make either throw. This runs inside a bare
    // setInterval (server/index.js), so an uncaught throw here would take down the whole
    // process — catch per-client so one bad socket can't abort the sweep for the rest.
    try {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    } catch { /* keep sweeping the rest of the clients */ }
  }
}
