/**
 * client.js - the browser side of Distributed Tic-Tac-Toe
 *
 * THIN CLIENT: this file never decides anything about the game.
 *   - It sends the player's clicks to the server ("move").
 *   - It draws whatever state the server sends back ("game:state").
 * There is NO local opponent and NO local win detection. If the server does not
 * confirm a move, nothing changes on screen.
 *
 * DISTRIBUTED COMPUTING CONCEPT: multiple independent clients.
 * Every browser tab runs its own copy of this file with its own connection
 * (its own socket id). They never talk to each other directly.
 */
(function () {
  'use strict';

  // Opens a WebSocket connection to the server that served this page.
  // Network communication starts here.
  const socket = io();

  // Handy for experiments: in the browser console, try
  //   __socket.emit('move', { index: 4 })
  // to send a request by hand and watch the server accept or reject it.
  window.__socket = socket;

  /* ------------------------------- local UI state ------------------------ */

  const ui = {
    name: '',            // name typed by this player
    wantsToPlay: false,  // true while this player is in the queue or in a game
    you: null,           // 'X' or 'O', assigned by the server
    game: null,          // latest state received from the server (read-only copy)
  };

  const $ = (id) => document.getElementById(id);

  const screens = {
    join: $('screen-join'),
    waiting: $('screen-waiting'),
    game: $('screen-game'),
    left: $('screen-left'),
  };
  const boardEl = $('board');
  const statusEl = $('status');
  const restartBtn = $('btn-restart');
  const restartNote = $('restart-note');
  const logEl = $('log');
  const toastEl = $('toast');

  const X_SVG =
    '<svg class="mark mark-x" viewBox="0 0 100 100" aria-hidden="true">' +
    '<path d="M24 24 L76 76" pathLength="100"/><path d="M76 24 L24 76" pathLength="100"/></svg>';
  const O_SVG =
    '<svg class="mark mark-o" viewBox="0 0 100 100" aria-hidden="true">' +
    '<circle cx="50" cy="50" r="28" pathLength="100"/></svg>';

  /* --------------------------------- screens ----------------------------- */

  function showScreen(name) {
    Object.keys(screens).forEach((key) => {
      screens[key].hidden = key !== name;
    });
  }

  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function setConnection(state, text) {
    $('conn').dataset.state = state;
    $('conn-text').textContent = text;
  }

  /* ------------------------------ network inspector ---------------------- */

  function timestamp() {
    return new Date().toLocaleTimeString([], { hour12: false });
  }

  function addLog(direction, eventName, payload) {
    const li = document.createElement('li');
    li.className = direction; // 'out' or 'in'

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = timestamp() + (direction === 'out' ? '  sent to server' : '  received from server');

    const evt = document.createElement('span');
    evt.className = 'evt';
    evt.textContent = eventName;

    li.appendChild(meta);
    li.appendChild(evt);

    if (payload !== undefined) {
      let text = JSON.stringify(payload);
      if (text.length > 220) text = text.slice(0, 220) + '...';
      const body = document.createElement('span');
      body.className = 'payload';
      body.textContent = text;
      li.appendChild(body);
    }

    logEl.insertBefore(li, logEl.firstChild); // newest message on top
    while (logEl.children.length > 80) logEl.lastChild.remove();
  }

  // Socket.IO can report every message in both directions. This is MESSAGE
  // PASSING made visible: the whole game is just these small messages.
  socket.onAny((eventName, payload) => {
    if (eventName === 'server:stats') return; // too chatty for the log
    addLog('in', eventName, payload);
  });
  socket.onAnyOutgoing((eventName, payload) => addLog('out', eventName, payload));

  $('btn-clear-log').addEventListener('click', () => { logEl.textContent = ''; });

  /* ------------------------------- board setup --------------------------- */

  const cells = [];
  for (let i = 0; i < 9; i += 1) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell empty';
    cell.dataset.mark = '';
    cell.setAttribute('aria-label', cellLabel(i, ''));
    cell.addEventListener('click', () => onCellClick(i));
    boardEl.appendChild(cell);
    cells.push(cell);
  }

  function cellLabel(index, mark) {
    return 'Row ' + (Math.floor(index / 3) + 1) + ', column ' + ((index % 3) + 1) + ', ' + (mark || 'empty');
  }

  function onCellClick(index) {
    if (!ui.game || ui.game.status !== 'playing') return;
    // We deliberately do NOT check the turn or whether the square is taken here.
    // Every click goes to the server, which is the only judge. Click an
    // occupied square or play out of turn to watch the server reject the move.
    socket.emit('move', { index: index });
  }

  /* -------------------------------- rendering ---------------------------- */

  function makeMark(symbol, animate) {
    const holder = document.createElement('span');
    holder.innerHTML = symbol === 'X' ? X_SVG : O_SVG; // constant markup, no user data
    const svg = holder.firstElementChild;
    if (animate) svg.classList.add('fresh');
    return svg;
  }

  function renderBoard(game) {
    const winning = new Set(game.winLine || []);
    const playing = game.status === 'playing';

    cells.forEach((cell, i) => {
      const value = game.board[i] || '';

      if (value !== cell.dataset.mark) {
        cell.textContent = '';
        if (value) cell.appendChild(makeMark(value, true));
        cell.dataset.mark = value;
        cell.setAttribute('aria-label', cellLabel(i, value));
      }

      cell.className = ['cell', value ? value.toLowerCase() : 'empty', winning.has(i) ? 'win' : '']
        .filter(Boolean)
        .join(' ');
      cell.disabled = !playing;
    });

    boardEl.classList.toggle('my-turn', playing && game.turn === ui.you);
  }

  function plural(count, word) {
    return count + ' ' + word + (count === 1 ? '' : 's');
  }

  function renderPlayers(game) {
    ['X', 'O'].forEach((mark) => {
      const key = mark.toLowerCase();
      $('p-' + key + '-name').textContent = game.names[mark];
      $('p-' + key + '-role').textContent = mark === ui.you ? 'You' : 'Opponent';
      $('p-' + key + '-wins').textContent = plural(game.scores[mark], 'win');
      $('player-' + key).classList.toggle('active', game.status === 'playing' && game.turn === mark);
    });
    $('round-label').textContent = 'Round ' + game.round;
    $('draws-label').textContent = plural(game.scores.draws, 'draw');
  }

  function renderStatus(game) {
    const opponentMark = ui.you === 'X' ? 'O' : 'X';
    const opponentName = game.names[opponentMark];
    let text;
    let tone = '';

    if (game.status === 'playing') {
      if (game.turn === ui.you) {
        text = 'Your turn. Place an ' + ui.you + '.';
        tone = 'you';
      } else {
        text = 'Waiting for ' + opponentName + ' to move.';
      }
    } else if (game.status === 'draw') {
      text = 'Draw. The board is full.';
    } else if (game.winner === ui.you) {
      text = 'You win this round.';
      tone = 'win';
    } else {
      text = opponentName + ' wins this round.';
      tone = 'lose';
    }

    statusEl.textContent = text;
    statusEl.dataset.tone = tone;

    // Rematch controls: a new round needs both players to agree.
    const over = game.status !== 'playing';
    restartBtn.hidden = !over;
    restartNote.textContent = '';
    if (over) {
      const youVoted = game.restartVotes.indexOf(ui.you) !== -1;
      const opponentVoted = game.restartVotes.indexOf(opponentMark) !== -1;
      restartBtn.disabled = youVoted;
      restartBtn.textContent = youVoted ? 'Waiting for ' + opponentName : opponentVoted ? 'Accept rematch' : 'Play again';
      if (youVoted) restartNote.textContent = 'The next round starts when both players agree.';
      else if (opponentVoted) restartNote.textContent = opponentName + ' wants a rematch.';
    }
  }

  function renderGame(game) {
    renderPlayers(game);
    renderBoard(game);
    renderStatus(game);
    $('stat-version').textContent = String(game.version);
  }

  /* --------------------------- messages from the server ------------------ */

  let hasConnectedBefore = false;

  socket.on('connect', () => {
    const reconnecting = hasConnectedBefore;
    hasConnectedBefore = true;
    setConnection('connected', 'Connected as client ' + socket.id.slice(0, 5));

    // After a network drop the server forgot us (new socket id), so queue again.
    if (reconnecting && ui.wantsToPlay) {
      toast('Reconnected. Looking for an opponent.');
      showScreen('waiting');
      socket.emit('join', { name: ui.name });
    }
  });

  // FAULT HANDLING on the client: Socket.IO retries automatically in the background.
  socket.on('disconnect', () => {
    setConnection('offline', 'Connection lost. Reconnecting');
    toast('Lost connection to the server. Trying to reconnect.');
  });

  socket.on('connect_error', () => setConnection('offline', 'Cannot reach the server'));

  socket.on('server:stats', (stats) => {
    $('stat-connected').textContent = String(stats.connected);
    $('stat-waiting').textContent = String(stats.waiting);
    $('stat-games').textContent = String(stats.activeGames);
  });

  socket.on('waiting', () => {
    ui.game = null;
    $('stat-version').textContent = 'none';
    showScreen('waiting');
  });

  socket.on('game:start', (data) => {
    ui.you = data.you;
    ui.game = data.state;
    showScreen('game');
    renderGame(ui.game);
    toast('You are playing ' + data.you + '.');
  });

  socket.on('game:state', (state) => {
    if (!ui.game || state.gameId !== ui.game.gameId) return;
    // SYNCHRONIZATION: ignore any message older than what we already show.
    if (state.version < ui.game.version) return;
    ui.game = state;
    renderGame(state);
  });

  // The server refused our move. The board is unchanged; we only show why.
  socket.on('move:rejected', (data) => toast(data.reason));

  socket.on('notice', (data) => toast(data.message));

  // FAULT HANDLING: the opponent's connection closed or they left.
  socket.on('opponent:left', (data) => {
    ui.game = null;
    $('stat-version').textContent = 'none';
    const why = data.reason === 'left' ? 'left the game.' : 'lost their connection (' + data.reason + ').';
    $('left-message').textContent = data.name + ' ' + why + ' The game has ended on the server.';
    showScreen('left');
  });

  socket.on('left', () => {
    ui.game = null;
    ui.wantsToPlay = false;
    $('stat-version').textContent = 'none';
    showScreen('join');
  });

  socket.on('join:error', (data) => {
    ui.wantsToPlay = false;
    showScreen('join');
    showJoinError(data.message);
  });

  /* --------------------------- messages to the server -------------------- */

  function showJoinError(message) {
    const el = $('join-error');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function joinQueue() {
    ui.wantsToPlay = true;
    socket.emit('join', { name: ui.name });
  }

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('name-input').value.trim();
    if (!name) {
      showJoinError('Enter a display name.');
      return;
    }
    showJoinError('');
    ui.name = name;
    try { sessionStorage.setItem('ttt-name', name); } catch (e) { /* storage may be blocked */ }
    joinQueue();
  });

  restartBtn.addEventListener('click', () => socket.emit('restart'));
  $('btn-leave').addEventListener('click', () => socket.emit('leave'));
  $('btn-cancel').addEventListener('click', () => socket.emit('leave'));
  $('btn-requeue').addEventListener('click', joinQueue);
  $('btn-home').addEventListener('click', () => {
    ui.wantsToPlay = false;
    showScreen('join');
  });

  // Remember the name for this tab only (sessionStorage is per tab).
  try {
    const saved = sessionStorage.getItem('ttt-name');
    if (saved) $('name-input').value = saved;
  } catch (e) { /* ignore */ }

  showScreen('join');
})();
