// ═══════════════════════════════════════════════════════════════════════════
// DRAFT BATTLE PvP — game.js
// Sincronização via Firebase Realtime Database
// ═══════════════════════════════════════════════════════════════════════════

const { ref, set, get, onValue, update, remove, runTransaction, onDisconnect, serverTimestamp, db } = window.FB;

const MAX_BUDGET = 150_000_000;
const DRAFT_ORDER = [0,1,1,0,0,1,1,0,0,1,0]; // snake draft, 11 picks
const SLOTS_REQUIRED = { GK:1, DEF:4, MID:3, FWD:3 };
const SLOT_ORDER = ['GK','DEF','DEF','DEF','DEF','MID','MID','MID','FWD','FWD','FWD'];
const ROOM_TTL_MS = 1000 * 60 * 60 * 2; // salas expiram em 2h (limpeza client-side best-effort)

const $ = id => document.getElementById(id);

// ─── ESTADO LOCAL ────────────────────────────────────────────────────────────
const LOCAL = {
  allPlayers: [],
  playersById: new Map(),
  roomCode: null,
  mySlot: null,        // 0 ou 1 — qual jogador EU sou nesta sala
  myName: '',
  room: null,           // último snapshot do room recebido do Firebase
  filterPos: 'ALL',
  searchTerm: '',
  viewingTeam: 1,
  picking: false,       // lock local pra evitar duplo clique
};

const fmtVal = v => v >= 1e6 ? `€${(v/1e6).toFixed(1)}M` : `€${(v/1e3).toFixed(0)}K`;
const fmtBudget = v => `€${(v/1e6).toFixed(0)}M`;

// ─── CARREGA BASE DE JOGADORES ──────────────────────────────────────────────
async function loadPlayers() {
  const res = await fetch('data/players.json');
  LOCAL.allPlayers = await res.json();
  LOCAL.allPlayers.forEach(p => LOCAL.playersById.set(p.id, p));
}

// ─── CÓDIGO DE SALA ──────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O/0/I/1 pra evitar confusão
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random()*chars.length)];
  return code;
}

function emptyRoomState(creatorName) {
  return {
    status: 'waiting',          // waiting -> drafting -> simulating -> finished
    createdAt: Date.now(),
    players: { 0: creatorName, 1: null },
    budgets: { 0: MAX_BUDGET, 1: MAX_BUDGET },
    teams:   { 0: [], 1: [] },     // arrays de player IDs
    pickIndex: 0,
    restriction: pickDailyRestriction(),
    result: null,
  };
}

// ─── RESTRIÇÃO DIÁRIA (compartilhada, seed por data) ────────────────────────
const RESTRICTIONS = [
  { id:'foreign',  label: '🌍 Apenas jogadores estrangeiros' },
  { id:'brazil',   label: '🇧🇷 Apenas jogadores brasileiros' },
  { id:'tall',     label: '📏 Apenas jogadores acima de 183cm' },
  { id:'cheap',    label: '💎 Valor máx €15M por jogador' },
  { id:'rated',    label: '🔥 Apenas jogadores com Rating ≥ 7.0' },
  { id:'scorer',   label: '⚡ Apenas atacantes/meias com 3+ gols (ponderado)' },
  { id:'passer',   label: '🎯 Apenas jogadores com 70%+ precisão de passe' },
  { id:'none',     label: '🏃 Sem restrição hoje — vale tudo!' },
];
function restrictionFn(id) {
  switch(id) {
    case 'foreign': return p => p.nac !== 'Brazil';
    case 'brazil':  return p => p.nac === 'Brazil';
    case 'tall':    return p => p.altura >= 183;
    case 'cheap':   return p => p.valor <= 15_000_000;
    case 'rated':   return p => (p.asr || 0) >= 7.0;
    case 'scorer':  return p => p.gls >= 3;
    case 'passer':  return p => (p.apspct || 0) >= 70;
    default:        return () => true;
  }
}
function pickDailyRestriction() {
  const todayKey = new Date().toISOString().slice(0,10).replace(/-/g,'');
  let seed = parseInt(todayKey) + 7;
  const rnd = mulberry32(seed)();
  const r = RESTRICTIONS[Math.floor(rnd * RESTRICTIONS.length)];
  return r.id;
}
function mulberry32(a){return function(){let t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}

// ═══════════════════════════════════════════════════════════════════════════
// TELA: LOBBY
// ═══════════════════════════════════════════════════════════════════════════

$('btn-create').onclick = async () => {
  const name = $('player-name').value.trim() || 'Treinador 1';
  LOCAL.myName = name;
  $('btn-create').disabled = true;
  $('btn-create').textContent = 'Criando...';

  try {
    let code, roomRef, exists;
    do {
      code = generateRoomCode();
      roomRef = ref(db, `rooms/${code}`);
      exists = (await get(roomRef)).exists();
    } while (exists);

    await set(roomRef, emptyRoomState(name));
    LOCAL.roomCode = code;
    LOCAL.mySlot = 0;

    // Remove a sala automaticamente se o criador sumir antes do rival entrar
    onDisconnect(ref(db, `rooms/${code}/players/0`)).set(null);

    $('room-code-display').textContent = code;
    showScreen('lobby');
    listenRoom(code);
  } catch (e) {
    showLobbyError('Erro ao criar sala. Tente novamente.');
    console.error(e);
  } finally {
    $('btn-create').disabled = false;
    $('btn-create').textContent = 'Criar Sala';
  }
};

$('btn-join').onclick = async () => {
  const name = $('player-name').value.trim() || 'Treinador 2';
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length < 4) { showLobbyError('Digite um código válido.'); return; }

  LOCAL.myName = name;
  $('btn-join').disabled = true;
  showLobbyError('');

  try {
    const roomRef = ref(db, `rooms/${code}`);
    const snap = await get(roomRef);
    if (!snap.exists()) { showLobbyError('Sala não encontrada.'); return; }

    const roomData = snap.val();
    if (roomData.players[1]) { showLobbyError('Sala já está cheia.'); return; }
    if (roomData.status !== 'waiting') { showLobbyError('Esta partida já começou.'); return; }

    await update(ref(db, `rooms/${code}/players`), { 1: name });
    await update(roomRef, { status: 'drafting' });

    LOCAL.roomCode = code;
    LOCAL.mySlot = 1;

    onDisconnect(ref(db, `rooms/${code}/players/1`)).set(null);

    listenRoom(code);
  } catch (e) {
    showLobbyError('Erro ao entrar na sala.');
    console.error(e);
  } finally {
    $('btn-join').disabled = false;
  }
};

function showLobbyError(msg) { $('lobby-error').textContent = msg; }

$('btn-cancel-room').onclick = async () => {
  if (LOCAL.roomCode) {
    await remove(ref(db, `rooms/${LOCAL.roomCode}`));
  }
  LOCAL.roomCode = null;
  LOCAL.mySlot = null;
  showScreen('splash');
};

$('btn-replay').onclick = async () => {
  if (LOCAL.roomCode) await remove(ref(db, `rooms/${LOCAL.roomCode}`));
  location.reload();
};

// ═══════════════════════════════════════════════════════════════════════════
// LISTENER PRINCIPAL — toda lógica de tela reage ao estado do Firebase
// ═══════════════════════════════════════════════════════════════════════════

function listenRoom(code) {
  const roomRef = ref(db, `rooms/${code}`);
  onValue(roomRef, (snap) => {
    if (!snap.exists()) {
      // Sala foi removida (rival saiu ou expirou)
      if (LOCAL.room) { // só alerta se já estávamos numa sala válida
        alert('A sala foi encerrada.');
        location.reload();
      }
      return;
    }
    const room = snap.val();
    LOCAL.room = room;
    renderFromRoom(room);
  });
}

function renderFromRoom(room) {
  if (room.status === 'waiting') {
    showScreen('lobby');
    return;
  }

  if (room.status === 'drafting') {
    showScreen('draft');
    renderDraftUI(room);
    return;
  }

  if (room.status === 'simulating') {
    showScreen('sim');
    // Apenas o criador (slot 0) conduz a simulação para evitar duplicidade
    if (LOCAL.mySlot === 0 && !LOCAL._simStarted) {
      LOCAL._simStarted = true;
      runSimulationAndSave(room);
    }
    return;
  }

  if (room.status === 'finished') {
    showScreen('result');
    renderResult(room);
    return;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAFT
// ═══════════════════════════════════════════════════════════════════════════

function teamIds(room, slot) { return room.teams[slot] || []; }
function teamPlayers(room, slot) { return teamIds(room, slot).map(id => LOCAL.playersById.get(id)).filter(Boolean); }

function neededPositions(room, slot) {
  const counts = {GK:0,DEF:0,MID:0,FWD:0};
  teamPlayers(room, slot).forEach(p => counts[p.posicao]++);
  return Object.entries(SLOTS_REQUIRED).filter(([pos,req]) => counts[pos] < req).map(([pos]) => pos);
}

function canPick(room, player, slot) {
  const counts = {GK:0,DEF:0,MID:0,FWD:0};
  teamPlayers(room, slot).forEach(p => counts[p.posicao]++);
  if (counts[player.posicao] >= SLOTS_REQUIRED[player.posicao]) return false;
  if (player.valor > room.budgets[slot]) return false;
  if (!restrictionFn(room.restriction)(player)) return false;
  return true;
}

function isPlayerTaken(room, playerId) {
  return teamIds(room,0).includes(playerId) || teamIds(room,1).includes(playerId);
}

function renderDraftUI(room) {
  const currentSlot = DRAFT_ORDER[room.pickIndex];
  const myTurn = currentSlot === LOCAL.mySlot;

  // Header
  $('name-p1').textContent = room.players[0] || 'J1';
  $('name-p2').textContent = room.players[1] || 'J2';
  $('budget-p1').textContent = fmtBudget(room.budgets[0]);
  $('budget-p2').textContent = fmtBudget(room.budgets[1]);
  $('turn-bar').className = `turn-indicator turn-p${currentSlot+1}`;
  $('round-label').textContent = `${Math.min(room.pickIndex+1,11)}/11`;

  renderSlotsDots(room);
  renderTeamPanel(room);

  if (room.pickIndex >= 11) return; // draft completo, aguardando transição p/ sim

  // Overlay de troca de vez — reseta sempre que o pickIndex muda,
  // independente de quem fez a jogada (host ou rival)
  if (LOCAL._lastPickIndexShown !== room.pickIndex) {
    LOCAL._lastPickIndexShown = room.pickIndex;
    LOCAL._overlayClosed = false;
  }

  if (!LOCAL._overlayClosed) {
    showTurnOverlay(room, currentSlot, myTurn);
  } else {
    $('turn-overlay').classList.add('hidden');
    renderPlayerList(room, currentSlot, myTurn);
  }
}

function showTurnOverlay(room, currentSlot, myTurn) {
  $('turn-overlay').classList.remove('hidden');
  const need = neededPositions(room, currentSlot);
  const pickNum = room.pickIndex + 1;

  if (myTurn) {
    $('to-label').textContent = 'Sua vez!';
    $('to-name').textContent = LOCAL.myName;
    $('to-name').className = `to-name to-p${LOCAL.mySlot+1}`;
    $('to-pick').textContent = `Escolha seu ${pickNum}º jogador — precisa de: ${need.join(', ')}`;
    $('btn-close-overlay').classList.remove('hidden');
    $('waiting-rival').classList.add('hidden');
  } else {
    const rivalName = room.players[currentSlot];
    $('to-label').textContent = 'Aguarde';
    $('to-name').textContent = rivalName;
    $('to-name').className = `to-name to-p${currentSlot+1}`;
    $('to-pick').textContent = `${rivalName} está escolhendo o ${pickNum}º jogador...`;
    $('btn-close-overlay').classList.add('hidden');
    $('waiting-rival').classList.remove('hidden');
  }
}

$('btn-close-overlay').onclick = () => {
  LOCAL._overlayClosed = true;
  $('turn-overlay').classList.add('hidden');
  showTeam(LOCAL.mySlot + 1);
  renderPlayerList(LOCAL.room, DRAFT_ORDER[LOCAL.room.pickIndex], true);
};

function renderPlayerList(room, currentSlot, myTurn) {
  const container = $('players-list');
  if (!myTurn) {
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--gray);font-size:.85rem">Aguardando o rival escolher...</div>';
    return;
  }

  const term = LOCAL.searchTerm.toLowerCase();
  let list = LOCAL.allPlayers.filter(p => {
    if (isPlayerTaken(room, p.id)) return false;
    if (LOCAL.filterPos !== 'ALL' && p.posicao !== LOCAL.filterPos) return false;
    if (term && !p.nome.toLowerCase().includes(term) && !p.clube.toLowerCase().includes(term)) return false;
    return true;
  });

  list.sort((a,b) => {
    const aOk = canPick(room, a, currentSlot) ? 0 : 1;
    const bOk = canPick(room, b, currentSlot) ? 0 : 1;
    if (aOk !== bOk) return aOk - bOk;
    return b.valor - a.valor;
  });

  container.innerHTML = '';
  if (list.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--gray);font-size:.85rem">Nenhum jogador disponível</div>';
    return;
  }

  list.slice(0, 80).forEach(p => {
    const ok = canPick(room, p, currentSlot);
    const div = document.createElement('div');
    div.className = `player-card${ok?'':' unavailable'}`;
    div.innerHTML = `
      <div class="pc-pos pos-${p.posicao}">${p.pos_det||p.posicao}</div>
      <div class="pc-info">
        <div class="pc-name">${p.nome}</div>
        <div class="pc-meta">${p.clube} · ${p.nac}</div>
      </div>
      <div class="pc-stats">
        <div class="pc-valor">${fmtVal(p.valor)}</div>
        <div class="pc-power">PWR ${p.power}</div>
        <div class="power-bar"><div class="power-fill" style="width:${p.power}%"></div></div>
      </div>`;
    if (ok) div.onclick = () => doPick(p.id, currentSlot);
    container.appendChild(div);
  });
}

async function doPick(playerId, slot) {
  if (LOCAL.picking) return;
  LOCAL.picking = true;

  const roomRef = ref(db, `rooms/${LOCAL.roomCode}`);
  try {
    await runTransaction(roomRef, (room) => {
      if (!room) return room;
      // Revalida tudo dentro da transação (evita race condition entre os 2 clientes)
      if (DRAFT_ORDER[room.pickIndex] !== slot) return room; // não é a vez dele
      if (isPlayerTaken(room, playerId)) return room;         // já foi pego

      const player = LOCAL.playersById.get(playerId);
      if (!player) return room;
      if (!canPick(room, player, slot)) return room;

      room.teams[slot] = [...(room.teams[slot]||[]), playerId];
      room.budgets[slot] -= player.valor;
      room.pickIndex += 1;

      if (room.pickIndex >= 11) {
        room.status = 'simulating';
      }
      return room;
    });
    LOCAL._overlayClosed = false; // próximo pick mostra overlay de novo
  } catch (e) {
    console.error('Erro no pick:', e);
  } finally {
    LOCAL.picking = false;
  }
}

function renderSlotsDots(room) {
  [0,1].forEach(slot => {
    const el = $(`slots-p${slot+1}`);
    el.innerHTML = '';
    const n = teamIds(room, slot).length;
    for (let s = 0; s < 11; s++) {
      const dot = document.createElement('div');
      dot.className = `slot-dot${s < n ? ' filled' : ''}`;
      el.appendChild(dot);
    }
  });
}

window.showTeam = (n) => {
  LOCAL.viewingTeam = n;
  $('tab-p1').className = `team-tab${n===1?' active-p1':''}`;
  $('tab-p2').className = `team-tab${n===2?' active-p2':''}`;
  if (LOCAL.room) renderTeamPanel(LOCAL.room);
};
$('tab-p1').onclick = () => showTeam(1);
$('tab-p2').onclick = () => showTeam(2);

function renderTeamPanel(room) {
  const slot = LOCAL.viewingTeam - 1;
  const team = teamPlayers(room, slot);
  const panel = $('team-panel');

  $('tab-p1').textContent = `Time ${room.players[0] || 'J1'}`;
  $('tab-p2').textContent = `Time ${room.players[1] || 'J2'}`;

  const byPos = {GK:[],DEF:[],MID:[],FWD:[]};
  team.forEach(p => byPos[p.posicao].push(p));

  let html = '';
  let i = 1;
  SLOT_ORDER.forEach(pos => {
    const p = byPos[pos].shift();
    html += `<div class="team-slot">
      <div class="ts-num">${i++}</div>
      <div class="ts-pos pos-${pos}">${pos}</div>
      ${p
        ? `<div class="ts-name">${p.nome}</div><div class="ts-val">${fmtVal(p.valor)}</div>`
        : `<div class="ts-empty">— vazio —</div>`}
    </div>`;
  });

  const gasto = MAX_BUDGET - room.budgets[slot];
  html += `<div style="margin-top:6px;font-size:.7rem;color:var(--gray);text-align:right">Gasto: ${fmtVal(gasto)} / €150M</div>`;
  panel.innerHTML = html;
}

// Filtros
document.querySelectorAll('.pos-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    LOCAL.filterPos = btn.dataset.pos;
    if (LOCAL.room) renderPlayerList(LOCAL.room, DRAFT_ORDER[LOCAL.room.pickIndex], DRAFT_ORDER[LOCAL.room.pickIndex] === LOCAL.mySlot);
  };
});
$('search-input').oninput = (e) => {
  LOCAL.searchTerm = e.target.value;
  if (LOCAL.room) renderPlayerList(LOCAL.room, DRAFT_ORDER[LOCAL.room.pickIndex], DRAFT_ORDER[LOCAL.room.pickIndex] === LOCAL.mySlot);
};

// ═══════════════════════════════════════════════════════════════════════════
// SIMULAÇÃO (determinística — conduzida só pelo slot 0, resultado salvo no Firebase)
// ═══════════════════════════════════════════════════════════════════════════

function teamPower(team) {
  let atk=0, mid=0, def=0, gk=0, total=0;
  team.forEach(p => {
    const pwr = p.power || 30;
    if (p.posicao === 'FWD') atk += pwr;
    if (p.posicao === 'MID') mid += pwr;
    if (p.posicao === 'DEF') def += pwr;
    if (p.posicao === 'GK')  gk  += pwr;
    total += pwr;
  });
  return { atk, mid, def, gk, total: total/team.length };
}

// RNG com seed compartilhada (createdAt da sala) — ambos calculam o mesmo resultado
function seededRng(seed) { return mulberry32(seed); }

function simulateMatch(room) {
  const t1 = teamPlayers(room, 0);
  const t2 = teamPlayers(room, 1);
  const rng = seededRng(room.createdAt + room.pickIndex);

  const p1 = teamPower(t1);
  const p2 = teamPower(t2);

  const chance1 = (p1.atk + p1.mid*0.4) / (p2.def + p2.gk + 1);
  const chance2 = (p2.atk + p2.mid*0.4) / (p1.def + p1.gk + 1);

  const lambda1 = Math.min(chance1 * 0.09, 5);
  const lambda2 = Math.min(chance2 * 0.09, 5);

  function poisson(lam) {
    let g=0, p=Math.exp(-lam), s=p;
    const u = rng();
    while (u > s) { g++; p *= lam/g; s += p; if (g>10) break; }
    return Math.max(0,g);
  }

  const g1 = poisson(lambda1);
  const g2 = poisson(lambda2);

  const events = [];
  const scorers1 = t1.filter(p=>p.posicao==='FWD'||p.posicao==='MID');
  const scorers2 = t2.filter(p=>p.posicao==='FWD'||p.posicao==='MID');

  for (let i=0;i<g1;i++){
    const min = Math.floor(rng()*85)+5;
    const p = scorers1.length ? scorers1[Math.floor(rng()*scorers1.length)] : t1[0];
    events.push({min, slot:0, text:`⚽ ${p.nome} marca!`, scorerId:p?.id});
  }
  for (let i=0;i<g2;i++){
    const min = Math.floor(rng()*85)+5;
    const p = scorers2.length ? scorers2[Math.floor(rng()*scorers2.length)] : t2[0];
    events.push({min, slot:1, text:`⚽ ${p.nome} marca!`, scorerId:p?.id});
  }
  events.sort((a,b)=>a.min-b.min);

  const winnerTeam = g1>g2 ? t1 : g2>g1 ? t2 : null;
  let mvpId = null;
  if (winnerTeam) {
    const mvp = winnerTeam.reduce((best,p)=>(p.power||0)>(best.power||0)?p:best, winnerTeam[0]);
    mvpId = mvp?.id;
  }

  return { g1, g2, events, mvpId };
}

async function runSimulationAndSave(room) {
  const sim = simulateMatch(room);
  // Anima localmente enquanto salva
  animateSimUI(sim, async () => {
    await update(ref(db, `rooms/${LOCAL.roomCode}`), {
      status: 'finished',
      result: sim,
    });
  });
}

function animateSimUI(sim, onDone) {
  let ev = 0, cur1=0, cur2=0;
  $('sim-score').textContent = '0 × 0';
  $('sim-bar').style.width = '0%';
  const total = sim.events.length || 1;

  const interval = setInterval(() => {
    if (ev >= sim.events.length) {
      clearInterval(interval);
      $('sim-bar').style.width = '100%';
      $('sim-event').textContent = '🏁 Fim de jogo!';
      setTimeout(onDone, 1000);
      return;
    }
    const e = sim.events[ev++];
    if (e.slot === 0) cur1++; else cur2++;
    $('sim-score').textContent = `${cur1} × ${cur2}`;
    $('sim-event').textContent = `${e.min}' ${e.text}`;
    $('sim-bar').style.width = `${(ev/sim.events.length)*90}%`;
  }, 700);

  if (sim.events.length === 0) {
    setTimeout(() => {
      $('sim-bar').style.width = '100%';
      $('sim-event').textContent = '🏁 Fim de jogo! 0 × 0';
      setTimeout(onDone, 1000);
    }, 1400);
  }
}

// Quem NÃO é o slot 0 só vê a animação local (mesmos dados determinísticos)
// recalculados a partir do room — garante mesma experiência em ambas as telas
function showSimForNonHost(room) {
  const sim = simulateMatch(room);
  animateSimUI(sim, () => {}); // não salva — só anima, espera o host salvar
}

// ═══════════════════════════════════════════════════════════════════════════
// RESULTADO
// ═══════════════════════════════════════════════════════════════════════════

function renderResult(room) {
  const { g1, g2, mvpId } = room.result;
  $('rs1').textContent = g1;
  $('rs2').textContent = g2;

  const n1 = room.players[0], n2 = room.players[1];
  let title = '⚖️ Empate!';
  if (g1 > g2) title = `🏆 ${n1} venceu!`;
  if (g2 > g1) title = `🏆 ${n2} venceu!`;
  $('result-title').textContent = title;
  $('rt-head-p1').textContent = `🟢 ${n1}`;
  $('rt-head-p2').textContent = `🔵 ${n2}`;

  [0,1].forEach(slot => {
    const el = $(`rt-p${slot+1}`);
    const team = teamPlayers(room, slot);
    const byPos = {GK:[],DEF:[],MID:[],FWD:[]};
    team.forEach(p => byPos[p.posicao].push(p));
    el.innerHTML = SLOT_ORDER.map(pos => {
      const p = byPos[pos].shift();
      if (!p) return '';
      return `<div class="rt-player"><b>${p.nome}</b><span>PWR ${p.power}</span></div>`;
    }).join('');
  });

  const mvp = mvpId ? LOCAL.playersById.get(mvpId) : null;
  $('mvp-badge').textContent = mvp
    ? `⭐ MVP: ${mvp.nome} (${mvp.clube}) — Power ${mvp.power}`
    : '🤝 Nenhum destaque neste empate';
}

// ═══════════════════════════════════════════════════════════════════════════
// TELAS
// ═══════════════════════════════════════════════════════════════════════════

function showScreen(id) {
  ['splash','lobby','draft','sim','result'].forEach(s => $(s).classList.add('hidden'));
  $(id).classList.remove('hidden');

  // Quando entra em 'sim' e não é o host, dispara a animação local espelhada
  if (id === 'sim' && LOCAL.mySlot === 1 && !LOCAL._simShownNonHost) {
    LOCAL._simShownNonHost = true;
    showSimForNonHost(LOCAL.room);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

(async function init() {
  await loadPlayers();
  $('btn-create').disabled = false;
})();
