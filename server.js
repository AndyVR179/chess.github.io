const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));

const sessions = new Map();
const queue = [];
const privateRooms = new Map();
const games = new Map();

const LESSONS = [
  { id: 'opening-basics', title: 'Opening Basics', level: 'Beginner', xp: 25 },
  { id: 'forks', title: 'Tactical Forks', level: 'Beginner', xp: 35 },
  { id: 'pins', title: 'Pins and Skewers', level: 'Intermediate', xp: 40 },
  { id: 'endgame-king-pawn', title: 'King + Pawn Endgames', level: 'Intermediate', xp: 50 }
];

const PUZZLES = [
  {
    id: 'p1',
    prompt: 'White to move and win material.',
    board: [
      ['br', null, null, null, 'bk', null, null, 'br'],
      ['bp', 'bp', 'bp', null, null, 'bp', 'bp', 'bp'],
      [null, null, 'bn', null, null, null, null, null],
      [null, null, null, 'wq', null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ['wp', 'wp', 'wp', null, null, 'wp', 'wp', 'wp'],
      ['wr', null, null, null, 'wk', null, null, 'wr']
    ],
    turn: 'w',
    solution: { from: 'd5', to: 'd7' }
  }
];

const BOT_PROFILES = {
  pawnbot: { id: 'pawnbot', name: 'PawnBot', elo: 350, blunderRate: 0.6 },
  knightbot: { id: 'knightbot', name: 'KnightBot', elo: 800, blunderRate: 0.3 },
  queenbot: { id: 'queenbot', name: 'QueenBot', elo: 1200, blunderRate: 0.1 }
};

function readDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function json(res, code, payload) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1e6) { req.socket.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, part) => {
    const [k, v] = part.trim().split('=');
    if (k) acc[k] = decodeURIComponent(v || '');
    return acc;
  }, {});
}

function getUser(req) {
  const token = parseCookies(req).sessionToken;
  return token ? sessions.get(token) || null : null;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

function defaultProfile(username, role = 'kid') {
  return {
    username,
    role,
    avatar: '🦁',
    rating: 800,
    coins: 100,
    gems: 15,
    streak: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    badges: ['First Login'],
    completedLessons: [],
    puzzleSolved: 0,
    clubs: ['Chess Explorers'],
    friends: []
  };
}

function initialBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = `b${back[c]}`; b[1][c] = 'bp';
    b[6][c] = 'wp'; b[7][c] = `w${back[c]}`;
  }
  return b;
}

function toCoord(square) {
  const c = square.charCodeAt(0) - 97;
  const r = 8 - Number(square[1]);
  return [r, c];
}
function toSquare(r, c) { return String.fromCharCode(97 + c) + (8 - r); }
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function other(color) { return color === 'w' ? 'b' : 'w'; }
function cloneState(state) { return JSON.parse(JSON.stringify(state)); }

function findKing(board, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === `${color}k`) return [r, c];
    }
  }
  return null;
}

function isSquareAttacked(state, targetR, targetC, byColor) {
  const board = state.board;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p[0] !== byColor) continue;
      const t = p[1];
      const dr = targetR - r;
      const dc = targetC - c;
      const adr = Math.abs(dr);
      const adc = Math.abs(dc);

      if (t === 'p') {
        const dir = byColor === 'w' ? -1 : 1;
        if (dr === dir && adc === 1) return true;
      } else if (t === 'n') {
        if ((adr === 2 && adc === 1) || (adr === 1 && adc === 2)) return true;
      } else if (t === 'k') {
        if (adr <= 1 && adc <= 1) return true;
      } else {
        const dirs = [];
        if (t === 'b' || t === 'q') dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
        if (t === 'r' || t === 'q') dirs.push([1,0],[-1,0],[0,1],[0,-1]);
        for (const [sr, sc] of dirs) {
          let rr = r + sr, cc = c + sc;
          while (inBounds(rr, cc)) {
            if (rr === targetR && cc === targetC) return true;
            if (board[rr][cc]) break;
            rr += sr; cc += sc;
          }
        }
      }
    }
  }
  return false;
}

function pseudoMoves(state, r, c) {
  const board = state.board;
  const piece = board[r][c];
  if (!piece) return [];
  const color = piece[0];
  const type = piece[1];
  const moves = [];

  if (type === 'p') {
    const dir = color === 'w' ? -1 : 1;
    const start = color === 'w' ? 6 : 1;
    if (inBounds(r + dir, c) && !board[r + dir][c]) {
      moves.push([r + dir, c]);
      if (r === start && !board[r + 2 * dir][c]) moves.push([r + 2 * dir, c]);
    }
    for (const dc of [-1, 1]) {
      const nr = r + dir, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const target = board[nr][nc];
      if (target && target[0] !== color) moves.push([nr, nc]);
      if (state.enPassant && toSquare(nr, nc) === state.enPassant) moves.push([nr, nc]);
    }
  }

  if (type === 'n') {
    for (const [dr, dc] of [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]]) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const target = board[nr][nc];
      if (!target || target[0] !== color) moves.push([nr, nc]);
    }
  }

  if (type === 'b' || type === 'r' || type === 'q') {
    const dirs = [];
    if (type === 'b' || type === 'q') dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
    if (type === 'r' || type === 'q') dirs.push([1,0],[-1,0],[0,1],[0,-1]);
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (inBounds(nr, nc)) {
        const target = board[nr][nc];
        if (!target) moves.push([nr, nc]);
        else {
          if (target[0] !== color) moves.push([nr, nc]);
          break;
        }
        nr += dr; nc += dc;
      }
    }
  }

  if (type === 'k') {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const target = board[nr][nc];
        if (!target || target[0] !== color) moves.push([nr, nc]);
      }
    }

    const rights = state.castling[color];
    const enemy = other(color);
    if (!isSquareAttacked(state, r, c, enemy)) {
      if (rights.K && !board[r][5] && !board[r][6] && !isSquareAttacked(state, r, 5, enemy) && !isSquareAttacked(state, r, 6, enemy)) moves.push([r, 6]);
      if (rights.Q && !board[r][1] && !board[r][2] && !board[r][3] && !isSquareAttacked(state, r, 3, enemy) && !isSquareAttacked(state, r, 2, enemy)) moves.push([r, 2]);
    }
  }

  return moves;
}

function applyMoveToState(state, from, to, promotion = 'q') {
  const [fr, fc] = typeof from === 'string' ? toCoord(from) : from;
  const [tr, tc] = typeof to === 'string' ? toCoord(to) : to;
  const board = state.board;
  const piece = board[fr][fc];
  if (!piece) return null;
  const color = piece[0];
  const type = piece[1];

  const move = { from: toSquare(fr, fc), to: toSquare(tr, tc), piece, captured: board[tr][tc] || null, at: Date.now() };

  if (type === 'p' && state.enPassant && toSquare(tr, tc) === state.enPassant && !board[tr][tc]) {
    const capR = color === 'w' ? tr + 1 : tr - 1;
    move.captured = board[capR][tc];
    board[capR][tc] = null;
  }

  board[tr][tc] = piece;
  board[fr][fc] = null;

  if (type === 'k') {
    state.castling[color].K = false;
    state.castling[color].Q = false;
    if (Math.abs(tc - fc) === 2) {
      if (tc === 6) {
        board[tr][5] = board[tr][7]; board[tr][7] = null;
      } else if (tc === 2) {
        board[tr][3] = board[tr][0]; board[tr][0] = null;
      }
    }
  }

  if (type === 'r') {
    if (fr === 7 && fc === 0) state.castling.w.Q = false;
    if (fr === 7 && fc === 7) state.castling.w.K = false;
    if (fr === 0 && fc === 0) state.castling.b.Q = false;
    if (fr === 0 && fc === 7) state.castling.b.K = false;
  }
  if (move.captured === 'wr' && tr === 7 && tc === 0) state.castling.w.Q = false;
  if (move.captured === 'wr' && tr === 7 && tc === 7) state.castling.w.K = false;
  if (move.captured === 'br' && tr === 0 && tc === 0) state.castling.b.Q = false;
  if (move.captured === 'br' && tr === 0 && tc === 7) state.castling.b.K = false;

  state.enPassant = null;
  if (type === 'p' && Math.abs(tr - fr) === 2) {
    const epR = (fr + tr) / 2;
    state.enPassant = toSquare(epR, fc);
  }

  if (type === 'p' && (tr === 0 || tr === 7)) {
    board[tr][tc] = `${color}${['q','r','b','n'].includes(promotion) ? promotion : 'q'}`;
  }

  state.turn = other(state.turn);
  state.halfmove = type === 'p' || move.captured ? 0 : state.halfmove + 1;
  if (state.turn === 'w') state.fullmove += 1;
  return move;
}

function legalMoves(state, color = state.turn) {
  const list = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (!p || p[0] !== color) continue;
      for (const [tr, tc] of pseudoMoves(state, r, c)) {
        const next = cloneState(state);
        applyMoveToState(next, [r, c], [tr, tc]);
        const king = findKing(next.board, color);
        if (!king) continue;
        if (!isSquareAttacked(next, king[0], king[1], other(color))) {
          list.push({ from: toSquare(r, c), to: toSquare(tr, tc) });
        }
      }
    }
  }
  return list;
}

function evaluateGameStatus(game) {
  const state = game.state;
  const moves = legalMoves(state);
  const king = findKing(state.board, state.turn);
  const inCheck = king ? isSquareAttacked(state, king[0], king[1], other(state.turn)) : false;

  if (moves.length === 0) {
    game.status = inCheck ? 'checkmate' : 'stalemate';
    game.winner = inCheck ? (state.turn === 'w' ? game.players.black : game.players.white) : null;
  } else {
    game.status = 'active';
    game.winner = null;
  }
}

function createBaseState() {
  return {
    board: initialBoard(),
    turn: 'w',
    castling: { w: { K: true, Q: true }, b: { K: true, Q: true } },
    enPassant: null,
    halfmove: 0,
    fullmove: 1
  };
}

function createGame(white, black, source = 'matchmaking', bot = null) {
  const id = crypto.randomUUID();
  const game = {
    id,
    players: { white, black },
    source,
    bot,
    state: createBaseState(),
    moves: [],
    chat: [],
    status: 'active',
    winner: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  games.set(id, game);
  return game;
}

function publicGame(game) {
  return {
    id: game.id,
    players: game.players,
    source: game.source,
    bot: game.bot,
    board: game.state.board,
    turn: game.state.turn,
    castling: game.state.castling,
    enPassant: game.state.enPassant,
    status: game.status,
    winner: game.winner,
    moves: game.moves,
    chat: game.chat.slice(-50),
    createdAt: game.createdAt,
    updatedAt: game.updatedAt
  };
}

function ensureUser(req, res, user) {
  if (!user) { json(res, 401, { error: 'Login required.' }); return false; }
  return true;
}

function getAccount(username) {
  const db = readDb();
  return db.users.find(u => u.username === username) || null;
}

function updateAccount(username, updater) {
  const db = readDb();
  const idx = db.users.findIndex(u => u.username === username);
  if (idx < 0) return null;
  db.users[idx] = updater(db.users[idx]);
  writeDb(db);
  return db.users[idx];
}

function maybeBotMove(game) {
  if (!game.bot || game.status !== 'active') return;
  const turnUser = game.state.turn === 'w' ? game.players.white : game.players.black;
  if (turnUser !== game.bot.name) return;

  const moves = legalMoves(game.state);
  if (!moves.length) return evaluateGameStatus(game);
  const profile = BOT_PROFILES[game.bot.id];
  const choice = Math.random() < profile.blunderRate
    ? moves[Math.floor(Math.random() * moves.length)]
    : moves.find(m => /[1-8]$/.test(m.to) && (m.to.endsWith('4') || m.to.endsWith('5'))) || moves[0];

  const moveMeta = applyMoveToState(game.state, choice.from, choice.to);
  game.moves.push({ ...moveMeta, by: game.bot.name });
  evaluateGameStatus(game);
  game.updatedAt = Date.now();
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(__dirname, 'public', pathname);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const user = getUser(req);

  try {
    if (req.method === 'POST' && url.pathname === '/api/register') {
      const { username, password, role } = await parseBody(req);
      if (!username || !password || username.length < 3 || password.length < 6) return json(res, 400, { error: 'Username (3+) and password (6+) required.' });
      const db = readDb();
      if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) return json(res, 409, { error: 'Username already exists.' });
      db.users.push({ username, passwordHash: hashPassword(password), profile: defaultProfile(username, role || 'kid'), createdAt: Date.now() });
      writeDb(db);
      return json(res, 201, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const { username, password } = await parseBody(req);
      const db = readDb();
      const account = db.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
      if (!account || !verifyPassword(password || '', account.passwordHash)) return json(res, 401, { error: 'Invalid credentials.' });
      const token = crypto.randomUUID();
      sessions.set(token, account.username);
      res.setHeader('Set-Cookie', `sessionToken=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
      return json(res, 200, { ok: true, username: account.username });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = parseCookies(req).sessionToken;
      if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', 'sessionToken=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const account = user ? getAccount(user) : null;
      return json(res, 200, { username: user, profile: account ? account.profile : null });
    }

    if (url.pathname.startsWith('/api/') && ['/api/register', '/api/login', '/api/me'].indexOf(url.pathname) === -1) {
      if (!ensureUser(req, res, user)) return;
    }

    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      const account = getAccount(user);
      const myGames = [...games.values()].filter(g => g.players.white === user || g.players.black === user);
      return json(res, 200, {
        profile: account.profile,
        stats: {
          activeGames: myGames.filter(g => g.status === 'active').length,
          completedGames: myGames.filter(g => g.status !== 'active').length,
          lessonsCompleted: account.profile.completedLessons.length,
          puzzlesSolved: account.profile.puzzleSolved
        },
        announcements: [
          '🏆 Spring Championship opens Friday!',
          '🧩 New puzzle pack: Knight Tricks',
          '👪 Parent tip: Set your child play schedule in Parent Controls.'
        ]
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/lessons') {
      const account = getAccount(user);
      return json(res, 200, { lessons: LESSONS, completed: account.profile.completedLessons });
    }

    if (req.method === 'POST' && /^\/api\/lessons\/[\w-]+\/complete$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const lesson = LESSONS.find(l => l.id === id);
      if (!lesson) return json(res, 404, { error: 'Lesson not found.' });
      const account = updateAccount(user, acc => {
        if (!acc.profile.completedLessons.includes(id)) {
          acc.profile.completedLessons.push(id);
          acc.profile.coins += 15;
          acc.profile.gems += 2;
          acc.profile.badges = Array.from(new Set([...acc.profile.badges, `Lesson: ${lesson.title}`]));
        }
        return acc;
      });
      return json(res, 200, { ok: true, profile: account.profile });
    }

    if (req.method === 'GET' && url.pathname === '/api/puzzles/daily') {
      return json(res, 200, { puzzle: PUZZLES[0] });
    }

    if (req.method === 'POST' && url.pathname === '/api/puzzles/attempt') {
      const { puzzleId, from, to } = await parseBody(req);
      const puzzle = PUZZLES.find(p => p.id === puzzleId);
      if (!puzzle) return json(res, 404, { error: 'Puzzle not found.' });
      const correct = puzzle.solution.from === from && puzzle.solution.to === to;
      let profile = null;
      if (correct) {
        const account = updateAccount(user, acc => {
          acc.profile.puzzleSolved += 1;
          acc.profile.coins += 10;
          return acc;
        });
        profile = account.profile;
      }
      return json(res, 200, { correct, profile });
    }

    if (req.method === 'POST' && url.pathname === '/api/matchmaking/join') {
      if (queue.includes(user)) return json(res, 200, { queued: true });
      const waiting = queue.shift();
      if (waiting && waiting !== user) {
        const white = Math.random() > 0.5 ? waiting : user;
        const black = white === waiting ? user : waiting;
        const game = createGame(white, black, 'matchmaking');
        return json(res, 200, { matched: true, game: publicGame(game) });
      }
      queue.push(user);
      return json(res, 200, { queued: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/matchmaking/status') {
      const game = [...games.values()].find(g => (g.players.white === user || g.players.black === user) && g.source === 'matchmaking' && g.moves.length === 0);
      if (game) return json(res, 200, { matched: true, game: publicGame(game) });
      return json(res, 200, { matched: false, queued: queue.includes(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/private/create') {
      const code = crypto.randomBytes(3).toString('hex').toUpperCase();
      privateRooms.set(code, user);
      return json(res, 201, { code });
    }

    if (req.method === 'POST' && url.pathname === '/api/private/join') {
      const { code } = await parseBody(req);
      const host = privateRooms.get(String(code || '').toUpperCase());
      if (!host) return json(res, 404, { error: 'Room not found.' });
      if (host === user) return json(res, 400, { error: 'Cannot join your own room.' });
      privateRooms.delete(String(code || '').toUpperCase());
      const white = Math.random() > 0.5 ? host : user;
      const black = white === host ? user : host;
      const game = createGame(white, black, 'private');
      return json(res, 200, { game: publicGame(game) });
    }

    if (req.method === 'POST' && url.pathname === '/api/bots/play') {
      const { botId } = await parseBody(req);
      const bot = BOT_PROFILES[botId || 'pawnbot'];
      if (!bot) return json(res, 404, { error: 'Unknown bot.' });
      const userWhite = Math.random() > 0.5;
      const game = createGame(userWhite ? user : bot.name, userWhite ? bot.name : user, 'bot', { id: bot.id, name: bot.name });
      maybeBotMove(game);
      return json(res, 201, { game: publicGame(game), bot });
    }

    if (req.method === 'GET' && /^\/api\/games\/[\w-]+$/.test(url.pathname)) {
      const id = url.pathname.split('/').pop();
      const game = games.get(id);
      if (!game) return json(res, 404, { error: 'Game not found.' });
      if (![game.players.white, game.players.black].includes(user)) return json(res, 403, { error: 'Not in this game.' });
      maybeBotMove(game);
      return json(res, 200, { game: publicGame(game), legalMoves: legalMoves(game.state) });
    }

    if (req.method === 'POST' && /^\/api\/games\/[\w-]+\/move$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const game = games.get(id);
      if (!game) return json(res, 404, { error: 'Game not found.' });
      if (game.status !== 'active') return json(res, 400, { error: 'Game finished.' });
      const currentPlayer = game.state.turn === 'w' ? game.players.white : game.players.black;
      if (currentPlayer !== user) return json(res, 403, { error: 'Not your turn.' });
      const { from, to, promotion } = await parseBody(req);
      const moves = legalMoves(game.state);
      if (!moves.some(m => m.from === from && m.to === to)) return json(res, 400, { error: 'Illegal move.' });
      const meta = applyMoveToState(game.state, from, to, promotion);
      game.moves.push({ ...meta, by: user });
      evaluateGameStatus(game);
      game.updatedAt = Date.now();
      maybeBotMove(game);
      return json(res, 200, { game: publicGame(game), legalMoves: legalMoves(game.state) });
    }

    if (req.method === 'POST' && /^\/api\/games\/[\w-]+\/chat$/.test(url.pathname)) {
      const id = url.pathname.split('/')[3];
      const game = games.get(id);
      if (!game) return json(res, 404, { error: 'Game not found.' });
      const { message } = await parseBody(req);
      const clean = String(message || '').slice(0, 180).replace(/badword|hate/gi, '***');
      if (!clean.trim()) return json(res, 400, { error: 'Message required.' });
      game.chat.push({ by: user, message: clean, at: Date.now() });
      game.updatedAt = Date.now();
      return json(res, 201, { ok: true, chat: game.chat.slice(-50) });
    }

    if (req.method === 'GET' && url.pathname === '/api/clubs') {
      return json(res, 200, { clubs: [
        { id: 'club-1', name: 'Chess Explorers', members: 2134, desc: 'Beginner-friendly puzzles and team matches.' },
        { id: 'club-2', name: 'Tactics Ninjas', members: 907, desc: 'Daily tactical battles and puzzle streaks.' }
      ]});
    }

    if (req.method === 'GET' && url.pathname === '/api/parent-controls') {
      const account = getAccount(user);
      return json(res, 200, {
        enabled: account.profile.role === 'parent',
        controls: {
          chat: 'friends-only',
          maxDailyGames: 10,
          bedtimeLock: '20:30',
          lessonGoal: '20 mins/day'
        }
      });
    }

    serveStatic(req, res);
  } catch (err) {
    json(res, 500, { error: err.message || 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ChessKid Super Arena running at http://${HOST}:${PORT}`);
});
