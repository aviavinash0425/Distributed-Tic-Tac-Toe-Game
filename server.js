/**
 * server.js - the authoritative game server for Distributed Tic-Tac-Toe
 *
 * ARCHITECTURE (client-server)
 *
 *    Browser A  <--- WebSocket (Socket.IO) --->  +-------------------+
 *                                                |  This Node.js     |
 *    Browser B  <--- WebSocket (Socket.IO) --->  |  game server      |
 *                                                +-------------------+
 *
 * - Browsers are THIN CLIENTS. They only draw the board and send "move" requests.
 * - This server is the SINGLE SOURCE OF TRUTH. It owns the board, the turn,
 *   and the result. A client can never change the game by itself: it must ask
 *   the server, and the server decides.
 *
 * Run with:  npm install   then   npm start
 */

'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

// Socket.IO sits on top of the HTTP server. It uses WebSockets when it can
// (and falls back to HTTP long-polling if a network blocks WebSockets).
const io = new Server(server);

// Express only serves the static front-end files (HTML/CSS/JS).
// All GAME traffic goes through Socket.IO, not through Express routes.
app.use(express.static(path.join(__dirname, 'public')));

// A tiny HTTP endpoint so you can inspect the server's state from a browser:
// open http://localhost:3000/health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    ...currentStats(),
  });
});

/* ------------------------------------------------------------------------- *
 * SHARED, AUTHORITATIVE STATE (lives only in this process's memory)
 *
 * DISTRIBUTED COMPUTING CONCEPT: shared state.
 * The two players never talk to each other. They both read the SAME state
 * from the server, so they can never disagree about the board.
 * ------------------------------------------------------------------------- */

// socket.id -> { name, gameId }   (every client that has joined)
const players = new Map();

// gameId -> game object   (every running game)
const games = new Map();

// socket ids of players waiting for an opponent (first in, first matched)
let waitingQueue = [];

let nextGameNumber = 1;

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

/* ----------------------------- game helpers ------------------------------ */

function createGame(xId, oId) {
  const id = `game-${nextGameNumber++}`;
  const game = {
    id,
    players: { X: xId, O: oId },   // mark -> socket id
    board: Array(9).fill(null),    // 9 squares: null, 'X' or 'O'
    turn: 'X',                     // X always opens a round
    status: 'playing',             // 'playing' | 'won' | 'draw'
    winner: null,
    winLine: null,
    // DISTRIBUTED COMPUTING CONCEPT: versioning.
    // Every accepted change increases this number. Clients use it to ignore
    // stale messages that arrive late or out of order.
    version: 0,
    round: 1,
    restartVotes: new Set(),       // socket ids that asked for a rematch
    wins: { [xId]: 0, [oId]: 0 },  // scores are kept per player, not per mark
    draws: 0,
  };
  games.set(id, game);
  return game;
}

function symbolOf(game, socketId) {
  return game.players.X === socketId ? 'X' : 'O';
}

function evaluateBoard(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { status: 'won', winner: board[a], winLine: line };
    }
  }
  if (board.every((cell) => cell !== null)) {
    return { status: 'draw', winner: null, winLine: null };
  }
  return { status: 'playing', winner: null, winLine: null };
}

// The exact data the server sends to clients. Clients treat it as read-only.
function publicState(game) {
  const x = players.get(game.players.X);
  const o = players.get(game.players.O);
  return {
    gameId: game.id,
    board: game.board,
    turn: game.turn,
    status: game.status,
    winner: game.winner,
    winLine: game.winLine,
    version: game.version,
    round: game.round,
    names: { X: x.name, O: o.name },
    scores: {
      X: game.wins[game.players.X],
      O: game.wins[game.players.O],
      draws: game.draws,
    },
    restartVotes: ['X', 'O'].filter((m) => game.restartVotes.has(game.players[m])),
  };
}

// MESSAGE PASSING: server -> both clients in the game "room".
// A Socket.IO room is just a named group of connections.
function broadcastState(game) {
  io.to(game.id).emit('game:state', publicState(game));
}

// Tells each player which mark they own, plus the starting state.
function sendGameStart(game) {
  for (const mark of ['X', 'O']) {
    io.to(game.players[mark]).emit('game:start', {
      you: mark,
      state: publicState(game),
    });
  }
}

/* ------------------------------ matchmaking ------------------------------ */

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const xId = waitingQueue.shift();
    const oId = waitingQueue.shift();
    const xSocket = io.sockets.sockets.get(xId);
    const oSocket = io.sockets.sockets.get(oId);

    // Safety net: skip anyone who vanished while waiting.
    if (!xSocket || !oSocket) {
      if (xSocket) waitingQueue.unshift(xId);
      if (oSocket) waitingQueue.unshift(oId);
      continue;
    }

    const game = createGame(xId, oId);
    xSocket.join(game.id);
    oSocket.join(game.id);
    players.get(xId).gameId = game.id;
    players.get(oId).gameId = game.id;

    console.log(`[${game.id}] started: ${players.get(xId).name} (X) vs ${players.get(oId).name} (O)`);
    sendGameStart(game);
  }
}

/* ------------------------- stats and name cleaning ------------------------ */

function currentStats() {
  return {
    connected: io.sockets.sockets.size,  // concurrent connections right now
    waiting: waitingQueue.length,
    activeGames: games.size,
  };
}

function broadcastStats() {
  io.emit('server:stats', currentStats());
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16);
}

/* ------------------------------ fault handling ---------------------------- */

/**
 * Removes a player from the system (queue and/or game).
 *
 * DISTRIBUTED COMPUTING CONCEPT: fault handling.
 * Networks fail: tabs close, Wi-Fi drops, phones go to sleep. The server must
 * never assume a client is still there. When one disappears, we clean up the
 * shared state and tell the surviving client what happened.
 */
function removePlayer(socketId, reason) {
  waitingQueue = waitingQueue.filter((id) => id !== socketId);

  const player = players.get(socketId);
  if (player && player.gameId) {
    const game = games.get(player.gameId);
    if (game) {
      const opponentId = game.players.X === socketId ? game.players.O : game.players.X;
      games.delete(game.id); // the game cannot continue with one player

      const self = io.sockets.sockets.get(socketId);
      if (self) self.leave(game.id);

      const opponent = players.get(opponentId);
      if (opponent) opponent.gameId = null;

      const opponentSocket = io.sockets.sockets.get(opponentId);
      if (opponentSocket) {
        opponentSocket.leave(game.id);
        opponentSocket.emit('opponent:left', { name: player.name, reason });
      }
      console.log(`[${game.id}] ended: ${player.name} left (${reason})`);
    }
  }
  players.delete(socketId);
}

/* ---------------------------- Socket.IO events ---------------------------- */

// DISTRIBUTED COMPUTING CONCEPT: concurrent client connections.
// Node.js is single-threaded but event-driven: this callback runs once for
// EVERY new connection, and one process can keep thousands of them open.
io.on('connection', (socket) => {
  console.log(`client connected: ${socket.id}`);
  broadcastStats();

  // ---- client -> server: "join" { name } ----
  socket.on('join', (payload) => {
    const name = cleanName(payload && payload.name);
    if (!name) {
      return socket.emit('join:error', { message: 'Enter a display name of 1 to 16 characters.' });
    }

    const existing = players.get(socket.id);
    if (existing && (existing.gameId || waitingQueue.includes(socket.id))) {
      return socket.emit('join:error', { message: 'You are already in a game or waiting for one.' });
    }

    players.set(socket.id, { name, gameId: null });
    waitingQueue.push(socket.id);
    socket.emit('waiting', { name });
    tryMatch();
    broadcastStats();
  });

  // ---- client -> server: "move" { index } ----
  // DISTRIBUTED COMPUTING CONCEPT: synchronization and turn coordination.
  // Two players may click at nearly the same instant. Node.js handles one event
  // at a time, so moves are processed in a strict order. The first valid move
  // changes the state; the second is then checked against the NEW state and
  // rejected if it is no longer legal. No locks are needed.
  socket.on('move', (payload) => {
    const index = payload && payload.index;
    const reject = (reason) => socket.emit('move:rejected', { reason, index });

    const player = players.get(socket.id);
    if (!player || !player.gameId) return reject('You are not in a game.');

    const game = games.get(player.gameId);
    if (!game) return reject('This game no longer exists.');

    // Server-side validation. Never trust the client: a modified browser could
    // send anything, so every rule is enforced here.
    if (game.status !== 'playing') return reject('The game is already over.');

    const mark = symbolOf(game, socket.id);
    if (game.turn !== mark) return reject('It is not your turn.');
    if (!Number.isInteger(index) || index < 0 || index > 8) return reject('That is not a valid square.');
    if (game.board[index] !== null) return reject('That square is already taken.');

    // Valid move: update the authoritative state.
    game.board[index] = mark;
    game.version += 1;

    const result = evaluateBoard(game.board);
    game.status = result.status;
    game.winner = result.winner;
    game.winLine = result.winLine;

    if (result.status === 'won') {
      game.wins[socket.id] += 1;
    } else if (result.status === 'draw') {
      game.draws += 1;
    } else {
      game.turn = mark === 'X' ? 'O' : 'X';
    }

    // Both clients receive the same new state. This is how they stay in sync.
    broadcastState(game);
  });

  // ---- client -> server: "restart" ----
  // Coordination again: a rematch needs BOTH players to agree.
  socket.on('restart', () => {
    const player = players.get(socket.id);
    const game = player && player.gameId ? games.get(player.gameId) : null;
    if (!game) return;

    if (game.status === 'playing') {
      return socket.emit('notice', { message: 'Finish the current round first.' });
    }

    game.restartVotes.add(socket.id);

    if (game.restartVotes.size === 2) {
      // Swap marks so the other player opens the next round.
      game.players = { X: game.players.O, O: game.players.X };
      game.board = Array(9).fill(null);
      game.turn = 'X';
      game.status = 'playing';
      game.winner = null;
      game.winLine = null;
      game.restartVotes.clear();
      game.round += 1;
      game.version += 1;
      sendGameStart(game); // marks changed, so each client gets its mark again
    } else {
      broadcastState(game); // lets the opponent see "wants a rematch"
    }
  });

  // ---- client -> server: "leave" (player clicked Leave or Cancel) ----
  socket.on('leave', () => {
    removePlayer(socket.id, 'left');
    socket.emit('left');
    broadcastStats();
  });

  // ---- built-in event: the connection closed (tab closed, network lost) ----
  socket.on('disconnect', (reason) => {
    console.log(`client disconnected: ${socket.id} (${reason})`);
    removePlayer(socket.id, reason);
    broadcastStats();
  });
});

/* --------------------------------- startup -------------------------------- */

function lanAddresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if ((info.family === 'IPv4' || info.family === 4) && !info.internal) found.push(info.address);
    }
  }
  return found;
}

// Listening on 0.0.0.0 lets other devices on the same Wi-Fi reach the server.
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nDistributed Tic-Tac-Toe server is running.');
  console.log(`  This computer:   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  Other devices:   http://${ip}:${PORT}`);
  }
  console.log('');
});

/* ------------------------------------------------------------------------- *
 * SCALABILITY LIMITATIONS OF THIS SINGLE-SERVER DESIGN
 *
 * 1. Single point of failure: if this process stops, every game is lost.
 * 2. State lives in RAM (the Maps above). A restart wipes it, and a second
 *    server process would not see it.
 * 3. One process uses one CPU core, so capacity is bounded by one machine.
 * 4. Horizontal scaling needs extra pieces: a shared store (e.g. Redis), the
 *    Socket.IO Redis adapter so servers can broadcast to each other, and
 *    sticky sessions in the load balancer.
 * 5. Geography: every move makes a round trip to this one server, so distant
 *    players see more latency.
 * 6. Reconnects: a returning client gets a NEW socket id, so this simple
 *    server treats it as a new player. Real systems use session tokens.
 * ------------------------------------------------------------------------- */
