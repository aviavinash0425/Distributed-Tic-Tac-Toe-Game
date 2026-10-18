# Distributed Tic-Tac-Toe Using Socket Programming

A two-player Tic-Tac-Toe game built to demonstrate distributed computing. Two independent browser clients connect to one Node.js server over WebSockets (Socket.IO). The server owns the game: it validates every move, updates the board, detects the result and broadcasts the new state to both players.

- Frontend: HTML, CSS, JavaScript (no framework)
- Backend: Node.js, Express
- Real-time messaging: Socket.IO (WebSockets)

## Project structure

```
distributed-tictactoe/
  package.json        dependencies and the "npm start" script
  server.js           authoritative game server (all game logic lives here)
  README.md
  public/
    index.html        page structure
    style.css         responsive styling
    client.js         thin client: draws state, sends moves
```

## Install and run

Requires Node.js 16 or newer (check with `node --version`).

```bash
cd distributed-tictactoe
npm install
npm start
```

The terminal prints:

```
Distributed Tic-Tac-Toe server is running.
  This computer:   http://localhost:3000
  Other devices:   http://192.168.1.23:3000
```

Use another port if 3000 is busy:

```bash
# macOS / Linux
PORT=4000 npm start

# Windows PowerShell
$env:PORT=4000; npm start

# Windows Command Prompt
set PORT=4000 && npm start
```

## Test in two browser tabs

1. Run `npm start`.
2. Open `http://localhost:3000` in one tab. Enter a name (for example `Asha`) and click **Join game**. The tab shows "Waiting for an opponent".
3. Open `http://localhost:3000` in a second tab (a different browser or a private window also works). Enter a different name (for example `Ravi`) and click **Join game**.
4. Both tabs switch to the board. The first player to join is **X** and moves first.
5. Click squares alternately. Watch the **Network inspector** on the right: every click appears as a `move` message sent to the server, followed by a `game:state` message received from it.

Things to try:

| Test | Expected result |
|---|---|
| Click the board while it is the opponent's turn | Server rejects with "It is not your turn." Board is unchanged. |
| Click an occupied square | Server rejects with "That square is already taken." |
| Get three in a row | Both tabs show the result and highlight the winning line. |
| Fill the board with no winner | Both tabs show "Draw". |
| Click **Play again** in one tab | That tab waits. The other shows "wants a rematch". When both agree, marks swap and a new round starts. |
| Close one tab mid-game | The other tab shows the opponent left, with a **Find a new opponent** button. |
| Open a third and fourth tab | They are matched as a second, independent game. "Games running" shows 2. |
| Open `http://localhost:3000/health` | JSON snapshot of server state (clients, queue, games, uptime). |

## Test on two devices (same Wi-Fi)

1. Connect the computer running the server and the other device (phone, tablet, laptop) to the **same Wi-Fi network**.
2. Start the server with `npm start` and read the "Other devices" address it prints, for example `http://192.168.1.23:3000`.
   If no address is printed, find your IP manually:
   - Windows: `ipconfig` (look for "IPv4 Address")
   - macOS: `ipconfig getifaddr en0`
   - Linux: `hostname -I`
3. On the computer, open `http://localhost:3000`. On the second device, open the printed address in its browser.
4. Join with a different name on each device and play.

If the second device cannot connect:

- Allow Node.js through the firewall when the OS asks (Windows Defender Firewall, macOS firewall).
- Check both devices are on the same network. Guest Wi-Fi and some university or office networks block device-to-device traffic ("client isolation"). A phone hotspot works well as a fallback.
- Use `http://`, not `https://`.
- Check the port number matches if you set `PORT`.

## How it works

```
 Browser A (X)                       Node.js server                        Browser B (O)
 -------------                       --------------                        -------------
 emit("join", {name})  ------------>                    <------------  emit("join", {name})
                       <------------ game:start (you: X) ------------>   game:start (you: O)
 emit("move", {index}) ------------> validate move
                                     update board + turn
                                     check win / draw
                       <------------ game:state (broadcast) -------->    game:state
```

### Message protocol

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `join` | client to server | `{ name }` | Enter the matchmaking queue |
| `waiting` | server to client | `{ name }` | Queued, no opponent yet |
| `game:start` | server to client | `{ you, state }` | Match found, mark assigned (also sent on rematch) |
| `move` | client to server | `{ index }` | Request to play square 0 to 8 |
| `game:state` | server to both clients | full public state | Authoritative board, turn, result, scores, version |
| `move:rejected` | server to one client | `{ reason, index }` | Move failed server validation |
| `restart` | client to server | none | Vote for a rematch (needs both players) |
| `leave` / `left` | client to server / server to client | none | Leave game or cancel waiting |
| `opponent:left` | server to client | `{ name, reason }` | Opponent disconnected or left |
| `server:stats` | server to all | `{ connected, waiting, activeGames }` | Live server numbers |

## Distributed computing concepts and where to find them

| Concept | Where it is demonstrated |
|---|---|
| Client-server architecture | Browsers only render and send requests. `server.js` holds all game logic. |
| Network communication and message passing | Every action is a named Socket.IO message over a WebSocket. The Network inspector shows each one live. |
| Multiple independent clients | Each tab has its own connection and socket id (shown in the header as "Connected as client ..."). Clients never talk to each other directly. |
| Shared authoritative game state | `games` Map in `server.js`. Clients keep a read-only copy and redraw from `game:state`. |
| Synchronization and turn coordination | The server accepts a move only from the player whose turn it is. Node.js processes events one at a time, so near-simultaneous clicks are ordered and the second is checked against the updated state. The `version` counter lets clients ignore stale messages. Rematches need both players to agree. |
| Concurrent client connections | Many sockets stay open at once. Extra pairs of players get their own games and Socket.IO rooms. "Clients connected" and "Games running" update live. |
| Basic fault handling | `removePlayer()` in `server.js` cleans up on `disconnect`, deletes the game and notifies the opponent. The client shows the connection state, retries automatically and re-queues after a reconnect. |
| Scalability limitations | See below, and the comment block at the end of `server.js`. |

No opponent is simulated locally. Every move and every state change travels through the server.

## Scalability limitations of this single-server design

1. **Single point of failure.** If the Node.js process stops, all games end.
2. **State is in memory.** A restart loses all games and scores. A second server process would not see the first one's games.
3. **Vertical limits only.** One process uses one CPU core on one machine. Throughput is capped by that machine.
4. **Horizontal scaling needs extra infrastructure.** Running several servers requires shared state (for example Redis or a database), the Socket.IO Redis adapter for cross-server broadcasts, and sticky sessions or a smarter load balancer so a player keeps reaching the same server.
5. **Latency depends on distance.** Each move is a round trip to one location, so far-away players see more delay.
6. **Weak reconnect handling.** A reconnecting client gets a new socket id, so this server treats it as a new player and the old game is gone. Production systems use session tokens and a grace period to let players resume.
7. **No authentication or rate limiting.** Anyone who can reach the server can join. The server validates move legality but does not limit message frequency.

## Troubleshooting

| Problem | Fix |
|---|---|
| `EADDRINUSE: address already in use` | Another program uses the port. Start with a different `PORT` (see above). |
| Page loads but stays on "Connecting" | Confirm the server is still running and the URL and port are correct. |
| Fonts look different | Fonts load from Google Fonts. With no internet the page uses system fonts and works normally. |
| Only one player joined | The server pairs players in order of arrival. Join from a second tab or device. |
