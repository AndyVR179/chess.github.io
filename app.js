const pieceMap = { wp:'♙',wr:'♖',wn:'♘',wb:'♗',wq:'♕',wk:'♔', bp:'♟',br:'♜',bn:'♞',bb:'♝',bq:'♛',bk:'♚' };
const $ = id => document.getElementById(id);
let me = null, profile = null, game = null, selected = null, puzzle = null;

function toast(msg){ $('toast').textContent = msg; }
async function api(path, method='GET', body){
  const res = await fetch(path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data = await res.json();
  if(!res.ok) throw new Error(data.error||'Request failed');
  return data;
}
function myColor(){ if(!game||!me) return null; return game.players.white===me?'w':game.players.black===me?'b':null; }

function renderBoard(target='board', boardData=game?.board){
  const root = $(target); root.innerHTML='';
  if(!boardData) return;
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){
    const sq = String.fromCharCode(97+c)+(8-r);
    const d = document.createElement('div');
    d.className = `square ${((r+c)%2)?'dark':'light'}`;
    if(target==='board' && selected===sq) d.classList.add('selected');
    d.textContent = boardData[r][c] ? pieceMap[boardData[r][c]] : '';
    if(target==='board') d.onclick = () => clickSquare(sq);
    root.appendChild(d);
  }
}

async function clickSquare(sq){
  if(!game||game.status!=='active') return;
  if(game.turn!==myColor()) return toast('Not your turn.');
  if(!selected){ selected = sq; return renderBoard(); }
  try{
    const out = await api(`/api/games/${game.id}/move`,'POST',{from:selected,to:sq,promotion:'q'});
    game = out.game; selected = null; renderBoard(); renderGame(); renderChat();
  }catch(e){ selected = null; renderBoard(); toast(e.message); }
}

function renderGame(){
  if(!game) return $('gameInfo').textContent = 'No game selected.';
  const turnName = game.turn==='w' ? game.players.white : game.players.black;
  const st = game.status==='active' ? `Turn: ${turnName}` : `${game.status.toUpperCase()} ${game.winner?`• Winner: ${game.winner}`:''}`;
  $('gameInfo').textContent = `${game.players.white} vs ${game.players.black} • ${st}`;
}

function renderProfile(){
  if(!profile) return $('profileCard').textContent='Not logged in';
  $('profileCard').innerHTML = `${profile.avatar} <b>${profile.username}</b><br/>Role: ${profile.role}<br/>Rating: ${profile.rating}<br/>Coins: ${profile.coins} • Gems: ${profile.gems}<br/>Streak: ${profile.streak}<br/>Badges: ${profile.badges.slice(0,2).join(', ')}`;
}

async function refreshMe(){ const data = await api('/api/me'); me = data.username; profile = data.profile; renderProfile(); }

async function loadDashboard(){
  if(!me) return;
  const d = await api('/api/dashboard');
  profile = d.profile; renderProfile();
}

async function loadLessons(){
  if(!me) return;
  const out = await api('/api/lessons');
  $('lessonsList').innerHTML = out.lessons.map(l => `<div class='row'><b>${l.title}</b> (${l.level}) +${l.xp} XP <button onclick="completeLesson('${l.id}')">Complete</button> ${out.completed.includes(l.id)?'✅':''}</div>`).join('');
}
window.completeLesson = async (id) => {
  try { const out = await api(`/api/lessons/${id}/complete`, 'POST'); profile = out.profile; renderProfile(); loadLessons(); toast('Lesson completed!'); }
  catch(e){ toast(e.message); }
};

async function loadPuzzle(){
  if(!me) return;
  const out = await api('/api/puzzles/daily');
  puzzle = out.puzzle;
  $('puzzlePrompt').textContent = puzzle.prompt;
  renderBoard('puzzleBoard', puzzle.board);
}

async function loadClubs(){
  if(!me) return;
  const out = await api('/api/clubs');
  $('clubsList').innerHTML = out.clubs.map(c => `<p><b>${c.name}</b> (${c.members} members)<br/>${c.desc}</p>`).join('');
}

async function loadParents(){
  if(!me) return;
  const out = await api('/api/parent-controls');
  $('parentControls').textContent = JSON.stringify(out, null, 2);
}

function renderChat(){
  $('chatBox').innerHTML = (game?.chat || []).map(m => `<div><b>${m.by}:</b> ${m.message}</div>`).join('');
}

document.querySelectorAll('.nav').forEach(btn => btn.onclick = async () => {
  document.querySelectorAll('.nav').forEach(n=>n.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  $(btn.dataset.tab).classList.add('active');
  if(btn.dataset.tab==='learn') await loadLessons();
  if(btn.dataset.tab==='puzzles') await loadPuzzle();
  if(btn.dataset.tab==='clubs') await loadClubs();
  if(btn.dataset.tab==='parents') await loadParents();
});

$('registerBtn').onclick = async () => { try { await api('/api/register','POST',{username:$('username').value,password:$('password').value,role:$('role').value}); toast('Registered! Please login.'); } catch(e){ toast(e.message); } };
$('loginBtn').onclick = async () => { try { await api('/api/login','POST',{username:$('username').value,password:$('password').value}); await refreshMe(); await loadDashboard(); toast('Logged in'); } catch(e){ toast(e.message); } };
$('logoutBtn').onclick = async () => { try { await api('/api/logout','POST'); me=null; profile=null; game=null; renderProfile(); renderGame(); renderBoard(); toast('Logged out'); } catch(e){ toast(e.message); } };

$('queueBtn').onclick = async () => {
  try{
    const out = await api('/api/matchmaking/join','POST');
    if(out.game){ game = out.game; renderBoard(); renderGame(); }
    $('matchStatus').textContent = out.game ? 'Matched!' : 'Searching...';
  }catch(e){ toast(e.message); }
};
$('createPrivateBtn').onclick = async ()=>{ try{ const out = await api('/api/private/create','POST'); $('privateCode').value = out.code; toast(`Share room code ${out.code}`);}catch(e){toast(e.message);} };
$('joinPrivateBtn').onclick = async ()=>{ try{ const out = await api('/api/private/join','POST',{code:$('privateCode').value.trim()}); game=out.game; renderBoard(); renderGame(); toast('Joined room');}catch(e){toast(e.message);} };
document.querySelectorAll('.botBtn').forEach(b => b.onclick = async ()=>{ try{ const out = await api('/api/bots/play','POST',{botId:b.dataset.bot}); game=out.game; renderBoard(); renderGame(); toast(`Now playing ${out.bot.name}`);}catch(e){toast(e.message);} });

$('sendChatBtn').onclick = async ()=>{ if(!game) return; try{ await api(`/api/games/${game.id}/chat`,'POST',{message:$('chatInput').value}); $('chatInput').value=''; } catch(e){toast(e.message);} };
$('solvePuzzleBtn').onclick = async ()=>{
  try{ const out = await api('/api/puzzles/attempt','POST',{puzzleId:puzzle.id,from:$('puzzleFrom').value.trim(),to:$('puzzleTo').value.trim()}); toast(out.correct?'Correct! +coins':'Try again!'); if(out.profile){ profile = out.profile; renderProfile(); }}
  catch(e){ toast(e.message); }
};

setInterval(async ()=>{
  if(!me) return;
  try {
    if(!game){
      const m = await api('/api/matchmaking/status');
      if(m.game){ game = m.game; renderBoard(); renderGame(); $('matchStatus').textContent='Match found!'; }
    } else {
      const g = await api(`/api/games/${game.id}`);
      game = g.game; renderBoard(); renderGame(); renderChat();
    }
  } catch {}
}, 1400);

(async function init(){
  try { await refreshMe(); if(me) await loadDashboard(); } catch {}
})();
