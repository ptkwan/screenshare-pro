const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  // Tolerância maior pra hiccups breves de rede (wifi instável, NIC saindo de
  // economia de energia, etc.) não derrubarem a conexão à toa — o padrão
  // (20s) é agressivo demais pra redes marginais e gera loop de
  // desconecta/reconecta sem que a rede tenha realmente caído.
  pingInterval: 25000,
  pingTimeout: 60000
});

const DEFAULT_TEXT_CHANNELS = ['geral', 'off-topic'];
const DEFAULT_VOICE_CHANNELS = ['Sala 1', 'Sala 2', 'Sala 3'];
const MAX_MESSAGES_PER_CHANNEL = 200;
const MAX_NAME_LENGTH = 40;

const rooms = new Map(); // roomId -> Set de socket ids (todo mundo no servidor/sala)
const roomChannels = new Map(); // roomId -> { text: string[], voice: string[] }
const roomVoiceMembers = new Map(); // roomId -> Map<canalDeVoz, Set<socketId>>
const roomBroadcasters = new Map(); // roomId -> Map<canalDeVoz, Set<socketId>>
const roomMessages = new Map(); // roomId -> Map<canalDeTexto, Array<mensagem>>
const roomPasswords = new Map(); // roomId -> hash da senha (só existe se a sala tiver senha)
const roomOwnerTokens = new Map(); // roomId -> token secreto (só quem criou a sala recebe)
const roomIcons = new Map(); // roomId -> ícone da sala (data URL base64, opcional)
const MAX_ICON_LENGTH = 300_000; // ~200KB de imagem em base64 -- gera muito pouco tráfego pra broadcast
// roomId -> Set<username> promovido a administrador pelo dono. Preso ao NOME
// (não a um token) de propósito -- sem sistema de conta/login, é o único jeito
// simples de "lembrar" quem é admin entre reconexões: continua admin enquanto
// reconectar com esse mesmo nome na mesma sala.
const roomAdminNames = new Map();

// ==========================================
// PERSISTÊNCIA (Upstash Redis, opcional) -- sem UPSTASH_REDIS_REST_URL e
// UPSTASH_REDIS_REST_TOKEN configurados, o app funciona exatamente como
// antes (tudo só em memória, some se o processo reiniciar). Com as
// variáveis configuradas, as salas sobrevivem a reinícios do servidor.
// ==========================================
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;

if (!redis) {
  console.log('[redis] UPSTASH_REDIS_REST_URL/TOKEN não configurados -- salas só na memória (não sobrevivem a um restart do servidor).');
}

const REDIS_ROOM_PREFIX = 'roshan:room:';
const REDIS_FLUSH_INTERVAL_MS = 5000; // agrupa gravações em vez de uma por mensagem/evento
const dirtyRooms = new Set();

function markRoomDirty(roomId) {
  if (redis) dirtyRooms.add(roomId);
}

function roomSnapshot(roomId) {
  return {
    channels: roomChannels.get(roomId),
    messages: Object.fromEntries(roomMessages.get(roomId) || []),
    passwordHash: roomPasswords.get(roomId) || null,
    ownerToken: roomOwnerTokens.get(roomId) || null,
    icon: roomIcons.get(roomId) || null,
    adminNames: Array.from(roomAdminNames.get(roomId) || []),
  };
}

async function flushDirtyRooms() {
  if (!redis || dirtyRooms.size === 0) return;
  const toFlush = Array.from(dirtyRooms);
  dirtyRooms.clear();
  for (const roomId of toFlush) {
    if (!rooms.has(roomId)) continue; // renomeada ou não existe mais sob esse nome
    try {
      await redis.set(REDIS_ROOM_PREFIX + roomId, roomSnapshot(roomId));
    } catch (e) {
      console.error(`[redis] falha ao salvar sala "${roomId}":`, e.message);
      dirtyRooms.add(roomId); // tenta de novo na próxima leva
    }
  }
}
if (redis) setInterval(flushDirtyRooms, REDIS_FLUSH_INTERVAL_MS);

async function deleteRoomFromRedis(roomId) {
  if (!redis) return;
  try { await redis.del(REDIS_ROOM_PREFIX + roomId); } catch (e) { console.error('[redis] falha ao apagar sala antiga do banco:', e.message); }
}

// Recupera todas as salas salvas ANTES do servidor aceitar conexões --
// assim, na visão de quem conecta, é como se o processo nunca tivesse
// reiniciado (exceto quem já tava conectado, que precisa entrar de novo).
async function loadRoomsFromRedis() {
  if (!redis) return;
  try {
    const keys = await redis.keys(REDIS_ROOM_PREFIX + '*');
    for (const key of keys) {
      const roomId = key.slice(REDIS_ROOM_PREFIX.length);
      const snap = await redis.get(key);
      if (!snap) continue;
      rooms.set(roomId, new Set());
      roomChannels.set(roomId, snap.channels || { text: [...DEFAULT_TEXT_CHANNELS], voice: [...DEFAULT_VOICE_CHANNELS] });
      roomMessages.set(roomId, new Map(Object.entries(snap.messages || {})));
      if (snap.passwordHash) roomPasswords.set(roomId, snap.passwordHash);
      if (snap.ownerToken) roomOwnerTokens.set(roomId, snap.ownerToken);
      if (snap.icon) roomIcons.set(roomId, snap.icon);
      if (snap.adminNames?.length) roomAdminNames.set(roomId, new Set(snap.adminNames));
      roomVoiceMembers.set(roomId, new Map());
      roomBroadcasters.set(roomId, new Map());
    }
    console.log(`[redis] ${keys.length} sala(s) recuperada(s) do banco.`);
  } catch (e) {
    console.error('[redis] falha ao carregar salas salvas -- iniciando só com o que tiver em memória:', e.message);
  }
}

function getRoomList() {
  return Array.from(rooms.entries())
    .map(([name, memberIds]) => ({
      name,
      hasPassword: roomPasswords.has(name),
      icon: roomIcons.get(name) || null,
      // Nome + avatar de quem está EM CHAMADA agora (canal de voz) -- usado
      // pro tooltip da barra de servidores conhecidos. Só quem tá em chamada,
      // não todo mundo conectado na sala (isso já aparece no painel de
      // participantes depois de entrar).
      members: Array.from(memberIds)
        .map(id => io.sockets.sockets.get(id))
        .filter(s => s && s.data.voiceChannel)
        .map(s => ({ name: s.data.username || 'Anônimo', avatar: s.data.avatar || null })),
    }));
}

function cleanName(raw, maxLen) {
  return (raw || '').toString().trim().slice(0, maxLen);
}

// O avatar sempre foi tratado como "qualquer string" (typeof avatar ===
// 'string'), sem checar formato -- isso permitia quebrar o atributo
// src="${user.avatar}" em avatarHtml() (index.html) com algo tipo
// `x" onerror="..."` e injetar JS arbitrário, broadcast pra sala inteira.
// Legítimo, o avatar SEMPRE é gerado por canvas.toDataURL('image/jpeg', ...)
// no cliente -- então só aceita esse formato exato (alfabeto base64 não tem
// nenhum caractere que quebre HTML/atributo, então isso já fecha a injeção
// por conta própria, sem precisar confiar em escape feito no cliente).
const AVATAR_DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_AVATAR_LENGTH = 300_000; // mesmo teto já usado pro ícone de sala

function sanitizeAvatar(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > MAX_AVATAR_LENGTH) return null;
  return AVATAR_DATA_URL_RE.test(raw) ? raw : null;
}

// Mesma validação do avatar (mesmo regex, já fecha a injeção por conta
// própria), mas com um teto bem maior -- imagem de chat (print de tela) é
// legitimamente mais pesada que uma foto de perfil pequena. O cliente já
// redimensiona/comprime antes de mandar; isso aqui é só o limite de
// segurança pro servidor não aceitar payload absurdo de qualquer socket.
// Precisa ficar ABAIXO do maxHttpBufferSize do socket.io (1_000_000 bytes --
// não configuramos isso explicitamente aqui, é o padrão da própria lib) --
// um valor maior que isso nunca seria alcançado por essa validação, porque o
// pacote já seria rejeitado na camada de transporte antes de chegar aqui (de
// um jeito menos controlado: o socket.io descarta o pacote, e dependendo do
// caso pode até derrubar a conexão). O restante do payload (canal, texto,
// framing do socket.io) também ocupa espaço nesse teto, daí a margem.
const MAX_CHAT_IMAGE_LENGTH = 700_000; // ~520KB decodificado, com folga sob o 1MB do transporte

function sanitizeChatImage(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > MAX_CHAT_IMAGE_LENGTH) return null;
  return AVATAR_DATA_URL_RE.test(raw) ? raw : null;
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update((pw || '').toString()).digest('hex');
}

// Compara hashes em tempo constante -- comparar string com "!==" direto
// vazaria informação por quanto tempo a comparação leva (timing attack),
// dando pra descobrir a senha certa byte a byte medindo a resposta.
function passwordMatches(candidate, storedHash) {
  const candidateHash = Buffer.from(hashPassword(candidate), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return candidateHash.length === stored.length && crypto.timingSafeEqual(candidateHash, stored);
}

// Limite de tentativas de senha por IP+sala -- sem isso, dava pra tentar
// senha atrás de senha sem parar (força bruta) já que não tem captcha nem
// conta de usuário nenhuma travando isso.
const PASSWORD_MAX_ATTEMPTS = 5;
const PASSWORD_LOCKOUT_MS = 60_000;
const passwordAttempts = new Map(); // "ip|sala" -> { count, lockedUntil }

function isLockedOut(key) {
  const entry = passwordAttempts.get(key);
  return !!entry && entry.lockedUntil > Date.now();
}

function registerFailedAttempt(key) {
  const entry = passwordAttempts.get(key) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= PASSWORD_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + PASSWORD_LOCKOUT_MS;
    entry.count = 0;
  }
  passwordAttempts.set(key, entry);
}

function clearAttempts(key) {
  passwordAttempts.delete(key);
}

function ensureRoomStructures(roomId) {
  if (!roomChannels.has(roomId)) {
    roomChannels.set(roomId, { text: [...DEFAULT_TEXT_CHANNELS], voice: [...DEFAULT_VOICE_CHANNELS] });
  }
  if (!roomVoiceMembers.has(roomId)) roomVoiceMembers.set(roomId, new Map());
  if (!roomBroadcasters.has(roomId)) roomBroadcasters.set(roomId, new Map());
  if (!roomMessages.has(roomId)) {
    const m = new Map();
    roomChannels.get(roomId).text.forEach(c => m.set(c, []));
    roomMessages.set(roomId, m);
  }
}

function sendChannelsInfo(roomId) {
  const channels = roomChannels.get(roomId);
  if (!channels) return;
  io.to(roomId).emit('channels-info', { textChannels: channels.text, voiceChannels: channels.voice });
}

// Junta a lista de usuários com canal de voz e status de "Ao Vivo"
function broadcastUserList(roomId) {
  if (!rooms.has(roomId)) return;
  const broadcasters = roomBroadcasters.get(roomId) || new Map();
  const users = Array.from(rooms.get(roomId)).map(id => {
    const s = io.sockets.sockets.get(id);
    const voiceChannel = s?.data.voiceChannel || null;
    return {
      id,
      name: s?.data.username || 'Anônimo',
      avatar: s?.data.avatar || null,
      isOwner: !!s?.data.isOwner,
      isAdmin: !!s?.data.isAdmin,
      voiceChannel,
      isStreaming: voiceChannel ? (broadcasters.get(voiceChannel)?.has(id) || false) : false
    };
  });
  io.to(roomId).emit('update-user-list', users);
}

function broadcastVoiceChannels(roomId) {
  const channels = roomChannels.get(roomId);
  const voiceMembers = roomVoiceMembers.get(roomId) || new Map();
  if (!channels) return;
  const payload = {};
  channels.voice.forEach(c => {
    payload[c] = Array.from(voiceMembers.get(c) || []).map(id => ({
      id,
      name: io.sockets.sockets.get(id)?.data.username || 'Anônimo'
    }));
  });
  io.to(roomId).emit('voice-channels-update', payload);
}

function leaveCurrentVoiceChannel(socket) {
  const room = socket.data.room;
  const channel = socket.data.voiceChannel;
  if (!room || !channel) return;

  const voiceMap = roomVoiceMembers.get(room);
  if (voiceMap && voiceMap.has(channel)) {
    voiceMap.get(channel).delete(socket.id);
  }

  const bcMap = roomBroadcasters.get(room);
  if (bcMap && bcMap.has(channel) && bcMap.get(channel).has(socket.id)) {
    bcMap.get(channel).delete(socket.id);
    io.to(room).emit('broadcaster-stopped', { userId: socket.id });
  }

  io.to(room).emit('voice-channel-left', { userId: socket.id, channel });
  socket.data.voiceChannel = null;
}

// Termina o processo de entrada de um socket numa sala -- usado tanto pro
// join direto (dono, ou sala nova) quanto pra quando uma entrada pendente é
// aprovada. Espera que socket.data.username/avatar/isOwner já estejam
// definidos antes de chamar.
function completeJoin(socket, roomId) {
  rooms.get(roomId).add(socket.id);
  socket.join(roomId);
  socket.data.room = roomId;
  socket.data.voiceChannel = null;

  socket.emit('room-joined', { roomId });

  sendChannelsInfo(roomId);

  const channels = roomChannels.get(roomId);
  const messages = roomMessages.get(roomId);
  const history = {};
  channels.text.forEach(c => { history[c] = messages.get(c) || []; });
  socket.emit('chat-history', history);

  broadcastUserList(roomId);
  broadcastVoiceChannels(roomId);

  socket.to(roomId).emit('user-connected', { userId: socket.id, userName: socket.data.username });
  io.emit('rooms-update', getRoomList());

  console.log(`[join] ${socket.id} (${socket.data.username}) entrou na sala "${roomId}"`);
}

// Tira um socket de uma sala sem desconectá-lo -- usado tanto quando ele
// sai de propósito ('leave-room', pra trocar de servidor sem fechar o app)
// quanto quando a conexão cai de vez (disconnect).
function removeFromRoom(socket, room) {
  leaveCurrentVoiceChannel(socket);
  socket.leave(room);

  if (!rooms.has(room)) return;
  rooms.get(room).delete(socket.id);
  if (rooms.get(room).size === 0) {
    // A sala fica de pé mesmo vazia -- canais, mensagens, senha, ícone e
    // token de dono continuam guardados (pedido explícito: "não tem como
    // ficarem de pé pra sempre?"). Com Redis configurado, isso sobrevive
    // até a um restart do processo; sem Redis, só dura enquanto o processo
    // ficar de pé (tudo em memória).
    io.emit('rooms-update', getRoomList());
  } else {
    broadcastUserList(room);
    broadcastVoiceChannels(room);
    io.to(room).emit('user-disconnected', socket.id);
    // Mesmo motivo do join/leave-voice-channel: se quem saiu/caiu estava em
    // chamada, o tooltip da barra de servidores (getRoomList()) precisa saber.
    io.emit('rooms-update', getRoomList());
  }
}

// Parte final, compartilhada, de "entrar numa sala": token de dono e
// completeJoin(). Usado tanto pelo join normal (por nome) quanto pelo join
// por código de sala oculta -- depois que cada um já decidiu QUAL sala é
// essa e QUE é permitido tentar entrar nela, o resto é idêntico.
function finishJoin(socket, roomId, { username, avatar, ownerToken, isNewRoom }) {
  ensureRoomStructures(roomId);

  socket.data.username = cleanName(username, MAX_NAME_LENGTH) || 'Anônimo';
  socket.data.avatar = sanitizeAvatar(avatar);

  // Dono da sala: quem cria recebe um token secreto (guardado só no cliente
  // dele) que prova a autoria em futuras reconexões — sem isso, qualquer um
  // que entrasse na sala poderia expulsar/renomear/trocar ícone à vontade.
  // Sala sem ninguém conectado agora com esse privilégio (dono nunca
  // existiu, ou perdeu o token trocando de navegador/PC) reivindica o
  // mesmo jeito, com um token novo -- o antigo, perdido, deixa de valer.
  const isOwnerByToken = !isNewRoom && !!ownerToken && roomOwnerTokens.get(roomId) === ownerToken;
  const ownerCurrentlyConnected = Array.from(rooms.get(roomId) || []).some(id => io.sockets.sockets.get(id)?.data.isOwner);
  if (isNewRoom || !ownerCurrentlyConnected) {
    const token = crypto.randomBytes(16).toString('hex');
    roomOwnerTokens.set(roomId, token);
    socket.data.isOwner = true;
    socket.emit('owner-token', { roomId, token });
    markRoomDirty(roomId);
  } else {
    socket.data.isOwner = isOwnerByToken;
  }

  // Admin "gruda" no nome dentro dessa sala -- reconectar (ou reentrar) com o
  // mesmo nome continua admin, sem precisar o dono promover de novo.
  socket.data.isAdmin = !isNewRoom && !!roomAdminNames.get(roomId)?.has(socket.data.username);

  completeJoin(socket, roomId);
}

function renameMapKey(map, oldKey, newKey) {
  if (map && map.has(oldKey) && !map.has(newKey)) {
    map.set(newKey, map.get(oldKey));
    map.delete(oldKey);
  }
}

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('get-rooms', () => {
    socket.emit('rooms-list', getRoomList());
  });

  socket.on('join-room', (payload) => {
    const { username, avatar, password, ownerToken } = payload || {};
    // roomId nunca era validado/limpo aqui -- qualquer string (incluindo lixo
    // tipo "[object Object]" vindo de um bug em outro lugar) virava o nome
    // literal e permanente da sala, sem chance de correção.
    const roomId = cleanName(payload?.roomId, MAX_NAME_LENGTH);
    if (!roomId) {
      socket.emit('join-error', { reason: 'invalid-room-name' });
      return;
    }

    const isNewRoom = !rooms.has(roomId);
    const attemptKey = `${socket.handshake.address}|${roomId}`;

    if (!isNewRoom && roomPasswords.has(roomId)) {
      if (isLockedOut(attemptKey)) {
        console.log(`[join] ${socket.id} bloqueado por excesso de tentativas de senha na sala "${roomId}"`);
        socket.emit('join-error', { reason: 'too-many-attempts' });
        return;
      }
      if (!passwordMatches(password, roomPasswords.get(roomId))) {
        registerFailedAttempt(attemptKey);
        console.log(`[join] ${socket.id} (${username}) errou a senha da sala "${roomId}"`);
        socket.emit('join-error', { reason: 'wrong-password' });
        return;
      }
      clearAttempts(attemptKey);
    }

    if (isNewRoom) {
      rooms.set(roomId, new Set());
      if (password) roomPasswords.set(roomId, hashPassword(password));
      markRoomDirty(roomId);
    }

    finishJoin(socket, roomId, { username, avatar, ownerToken, isNewRoom });
  });

  // Sai da sala atual sem fechar a conexão -- pra trocar de servidor sem
  // precisar fechar e reabrir o app inteiro (antes não existia jeito nenhum
  // de fazer isso uma vez dentro de uma sala).
  socket.on('leave-room', () => {
    const room = socket.data.room;
    if (!room) return;
    removeFromRoom(socket, room);
    socket.data.room = null;
    socket.data.isOwner = false;
    socket.data.isAdmin = false;
    socket.data.voiceChannel = null;
    console.log(`[leave-room] ${socket.id} (${socket.data.username}) saiu da sala "${room}"`);
  });

  socket.on('rename-self', ({ newName }) => {
    const room = socket.data.room;
    const trimmed = cleanName(newName, MAX_NAME_LENGTH);
    if (!trimmed) return;
    socket.data.username = trimmed;
    if (room) broadcastUserList(room);
  });

  socket.on('update-avatar', ({ avatar }) => {
    const room = socket.data.room;
    if (!room) return;
    socket.data.avatar = sanitizeAvatar(avatar);
    broadcastUserList(room);
  });

  socket.on('rename-room', ({ newName }) => {
    if (!socket.data.isOwner) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou renomear a sala sem ser dono`);
      return;
    }
    const oldRoom = socket.data.room;
    const trimmed = cleanName(newName, MAX_NAME_LENGTH);
    if (!oldRoom || !trimmed || trimmed === oldRoom || rooms.has(trimmed)) return;

    const memberIds = Array.from(rooms.get(oldRoom) || []);
    memberIds.forEach(id => {
      const s = io.sockets.sockets.get(id);
      if (s) {
        s.leave(oldRoom);
        s.join(trimmed);
        s.data.room = trimmed;
      }
    });

    renameMapKey(rooms, oldRoom, trimmed);
    renameMapKey(roomChannels, oldRoom, trimmed);
    renameMapKey(roomVoiceMembers, oldRoom, trimmed);
    renameMapKey(roomBroadcasters, oldRoom, trimmed);
    renameMapKey(roomMessages, oldRoom, trimmed);
    renameMapKey(roomPasswords, oldRoom, trimmed);
    renameMapKey(roomOwnerTokens, oldRoom, trimmed);
    renameMapKey(roomIcons, oldRoom, trimmed);
    renameMapKey(roomAdminNames, oldRoom, trimmed);
    deleteRoomFromRedis(oldRoom); // a sala "velha" não existe mais sob esse nome
    markRoomDirty(trimmed);

    io.to(trimmed).emit('room-renamed', { newName: trimmed });
    io.emit('rooms-update', getRoomList());
    console.log(`[rename] ${socket.id} renomeou a sala "${oldRoom}" pra "${trimmed}"`);
  });

  // Dono define/troca o ícone da sala (mostrado na lista de salas e na barra
  // de servidores conhecidos do cliente).
  socket.on('update-room-icon', ({ icon }) => {
    if (!socket.data.isOwner) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou trocar o ícone da sala sem ser dono`);
      return;
    }
    const room = socket.data.room;
    if (!room) return;
    const clean = typeof icon === 'string' && icon && icon.length <= MAX_ICON_LENGTH ? icon : null;
    if (clean) roomIcons.set(room, clean); else roomIcons.delete(room);
    markRoomDirty(room);
    io.emit('rooms-update', getRoomList());
    console.log(`[icone-sala] ${socket.id} atualizou o ícone da sala "${room}"`);
  });

  socket.on('rename-channel', ({ type, oldName, newName }) => {
    if (!socket.data.isOwner && !socket.data.isAdmin) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou renomear um canal sem ser dono/admin`);
      return;
    }
    const room = socket.data.room;
    const trimmed = cleanName(newName, MAX_NAME_LENGTH);
    if (!room || !trimmed) return;
    const channels = roomChannels.get(room);
    if (!channels) return;

    const list = type === 'text' ? channels.text : type === 'voice' ? channels.voice : null;
    if (!list) return;
    const idx = list.indexOf(oldName);
    if (idx === -1 || list.includes(trimmed)) return;
    list[idx] = trimmed;

    if (type === 'text') {
      renameMapKey(roomMessages.get(room), oldName, trimmed);
    } else {
      renameMapKey(roomVoiceMembers.get(room), oldName, trimmed);
      renameMapKey(roomBroadcasters.get(room), oldName, trimmed);
      rooms.get(room)?.forEach(id => {
        const s = io.sockets.sockets.get(id);
        if (s && s.data.voiceChannel === oldName) s.data.voiceChannel = trimmed;
      });
    }

    io.to(room).emit('channel-renamed', { type, oldName, newName: trimmed });
    sendChannelsInfo(room);
    broadcastUserList(room);
    broadcastVoiceChannels(room);
    markRoomDirty(room);
  });

  socket.on('send-message', ({ channel, text, image }) => {
    const room = socket.data.room;
    const channels = room ? roomChannels.get(room) : null;
    if (!room || !channels || !channels.text.includes(channel)) return;
    const trimmed = (text || '').toString().slice(0, 2000).trim();
    const cleanImage = sanitizeChatImage(image);
    // Mensagem precisa ter texto OU imagem -- as duas vazias não vira nada
    // (evita mensagem "fantasma" na lista, sem nada pra mostrar).
    if (!trimmed && !cleanImage) return;

    const msg = {
      id: `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: socket.id,
      userName: socket.data.username,
      text: trimmed,
      image: cleanImage,
      ts: Date.now()
    };

    const messages = roomMessages.get(room);
    const list = messages.get(channel);
    if (!list) return;
    list.push(msg);
    if (list.length > MAX_MESSAGES_PER_CHANNEL) list.shift();
    markRoomDirty(room);

    io.to(room).emit('chat-message', { channel, message: msg });
  });

  socket.on('join-voice-channel', ({ channel }) => {
    const room = socket.data.room;
    const channels = room ? roomChannels.get(room) : null;
    if (!room || !channels || !channels.voice.includes(channel)) return;
    if (socket.data.voiceChannel === channel) return;

    leaveCurrentVoiceChannel(socket);

    const voiceMap = roomVoiceMembers.get(room);
    if (!voiceMap.has(channel)) voiceMap.set(channel, new Set());
    voiceMap.get(channel).add(socket.id);
    socket.data.voiceChannel = channel;

    broadcastUserList(room);
    broadcastVoiceChannels(room);
    // getRoomList() (usado pelo tooltip de hover na barra de servidores) só
    // considera quem está EM CHAMADA -- sem isso, entrar/sair de um canal de
    // voz nunca atualizava essa lista (só join/leave da SALA disparavam esse
    // broadcast), deixando o tooltip preso no estado de quando a sala foi
    // aberta pela última vez.
    io.emit('rooms-update', getRoomList());
  });

  socket.on('leave-voice-channel', () => {
    const room = socket.data.room;
    leaveCurrentVoiceChannel(socket);
    if (room) {
      broadcastUserList(room);
      broadcastVoiceChannels(room);
      io.emit('rooms-update', getRoomList());
    }
  });

  socket.on('start-sharing', () => {
    const room = socket.data.room;
    const channel = socket.data.voiceChannel;
    if (!room || !channel) return;

    const bcMap = roomBroadcasters.get(room);
    if (!bcMap.has(channel)) bcMap.set(channel, new Set());
    bcMap.get(channel).add(socket.id);

    broadcastUserList(room);
    io.to(room).emit('broadcaster-started', { userId: socket.id, channel });
  });

  socket.on('stop-sharing', () => {
    const room = socket.data.room;
    const channel = socket.data.voiceChannel;
    if (!room || !channel) return;

    const bcMap = roomBroadcasters.get(room);
    if (bcMap.has(channel)) {
      bcMap.get(channel).delete(socket.id);
    }

    broadcastUserList(room);
    io.to(room).emit('broadcaster-stopped', { userId: socket.id });
  });

  socket.on('request-stream', ({ userId }) => {
    const room = socket.data.room;
    const channel = socket.data.voiceChannel;
    if (!room || !channel) return;
    const bcMap = roomBroadcasters.get(room);
    if (bcMap.get(channel)?.has(userId)) {
      io.to(userId).emit('viewer-requested', socket.id);
    }
  });

  socket.on('kick-user', ({ userId }) => {
    if (!socket.data.isOwner && !socket.data.isAdmin) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou expulsar sem ser dono/admin`);
      return;
    }
    const room = socket.data.room;
    if (!room || !userId || userId === socket.id) return;
    if (!rooms.get(room)?.has(userId)) return;

    const targetSocket = io.sockets.sockets.get(userId);
    if (!targetSocket) return;
    // Admin não pode expulsar o dono -- só o dono manda em quem manda.
    if (!socket.data.isOwner && targetSocket.data.isOwner) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou expulsar o dono sendo só admin`);
      return;
    }
    const targetName = targetSocket.data.username;

    // Desconectar logo depois do emit é uma corrida: o pacote pode se perder
    // na hora de fechar a conexão, e um "disconnect" iniciado pelo servidor
    // NÃO reconecta sozinho -- o app de quem foi expulso ficava travado, sem
    // aviso nenhum. Agora espera a confirmação (ack) do cliente antes de
    // desconectar, com um tempo limite de garantia caso a confirmação não
    // chegue (ex: versão antiga do app, sem esse suporte).
    let disconnected = false;
    const doDisconnect = (viaAck) => {
      if (disconnected) return;
      disconnected = true;
      console.log(`[kick] ${targetName} (${userId}) desconectado ${viaAck ? 'com confirmação do cliente' : 'por tempo limite (sem confirmação)'}`);
      if (targetSocket.connected) targetSocket.disconnect(true);
    };
    console.log(`[kick] ${socket.data.username} (${socket.id}) expulsou ${targetName} (${userId}) da sala "${room}"`);
    targetSocket.emit('kicked', { by: socket.data.username }, () => doDisconnect(true));
    setTimeout(() => doDisconnect(false), 1500);
  });

  // Promover/remover administrador -- só o dono decide (um admin não pode
  // promover outro admin nem a si mesmo). Fica preso ao NOME dentro da sala
  // (ver comentário de roomAdminNames): reconectar com o mesmo nome continua
  // admin, mas outro nome (ou trocar de sala) não carrega o cargo junto.
  socket.on('promote-admin', ({ userId }) => {
    if (!socket.data.isOwner) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou promover admin sem ser dono`);
      return;
    }
    const room = socket.data.room;
    if (!room || !userId || userId === socket.id) return;
    const targetSocket = io.sockets.sockets.get(userId);
    if (!targetSocket || targetSocket.data.room !== room) return;

    if (!roomAdminNames.has(room)) roomAdminNames.set(room, new Set());
    roomAdminNames.get(room).add(targetSocket.data.username);
    targetSocket.data.isAdmin = true;
    markRoomDirty(room);
    broadcastUserList(room);
    console.log(`[admin] ${socket.data.username} promoveu ${targetSocket.data.username} a administrador na sala "${room}"`);
  });

  socket.on('demote-admin', ({ userId }) => {
    if (!socket.data.isOwner) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou remover admin sem ser dono`);
      return;
    }
    const room = socket.data.room;
    if (!room || !userId) return;
    const targetSocket = io.sockets.sockets.get(userId);
    if (!targetSocket || targetSocket.data.room !== room) return;

    roomAdminNames.get(room)?.delete(targetSocket.data.username);
    targetSocket.data.isAdmin = false;
    markRoomDirty(room);
    broadcastUserList(room);
    console.log(`[admin] ${socket.data.username} removeu ${targetSocket.data.username} de administrador na sala "${room}"`);
  });

  // Apagar a sala inteira -- irreversível, só o dono. Tira todo mundo de
  // volta pro lobby e some com canais/mensagens/senha/ícone/admins, tanto da
  // memória quanto do Redis (se configurado).
  socket.on('delete-room', () => {
    if (!socket.data.isOwner) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou apagar a sala sem ser dono`);
      return;
    }
    const room = socket.data.room;
    if (!room || !rooms.has(room)) return;

    // Avisa ANTES de tirar todo mundo da room do socket.io -- `io.to(room)`
    // só alcança quem ainda está com `.join(room)` ativo, então emitir depois
    // do `.leave()` faria o evento não chegar em ninguém.
    io.to(room).emit('room-deleted');

    const memberIds = Array.from(rooms.get(room));
    memberIds.forEach(id => {
      const s = io.sockets.sockets.get(id);
      if (!s) return;
      s.leave(room);
      s.data.room = null;
      s.data.isOwner = false;
      s.data.isAdmin = false;
      s.data.voiceChannel = null;
    });

    rooms.delete(room);
    roomChannels.delete(room);
    roomVoiceMembers.delete(room);
    roomBroadcasters.delete(room);
    roomMessages.delete(room);
    roomPasswords.delete(room);
    roomOwnerTokens.delete(room);
    roomIcons.delete(room);
    roomAdminNames.delete(room);
    dirtyRooms.delete(room);
    deleteRoomFromRedis(room);

    io.emit('rooms-update', getRoomList());
    console.log(`[apaga-sala] ${socket.id} (${socket.data.username}) apagou a sala "${room}" pra sempre`);
  });

  // Retransmissão de sinalização WebRTC (voz e compartilhamento de tela) --
  // só entre quem está na MESMA sala. Antes disso, `target` era só um
  // socket.id qualquer sem checar sala nenhuma: qualquer socket conectado
  // (de outra sala, ou de nenhuma) conseguia mandar um 'offer' forjado pra
  // vítima e o cliente respondia automaticamente sem checar se o remetente é
  // membro conhecido -- na prática, dava pra iniciar uma conexão de voz com
  // alguém fora da sua sala e captar o microfone dela sem consentimento.
  function isRoommate(socket, targetId) {
    const room = socket.data.room;
    if (!room) return false;
    const targetSocket = io.sockets.sockets.get(targetId);
    return !!targetSocket && targetSocket.data.room === room;
  }

  socket.on('offer', ({ target, sdp }) => {
    if (!isRoommate(socket, target)) return;
    io.to(target).emit('offer', { caller: socket.id, sdp });
  });

  socket.on('answer', ({ target, sdp }) => {
    if (!isRoommate(socket, target)) return;
    io.to(target).emit('answer', { answerer: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate }) => {
    if (!isRoommate(socket, target)) return;
    io.to(target).emit('ice-candidate', { sender: socket.id, candidate });
  });

  socket.on('client-log', ({ level, message }) => {
    console.log(`[client-log:${level || 'info'}] ${socket.data.username || socket.id}: ${String(message).slice(0, 500)}`);
  });

  socket.on('disconnect', (reason) => {
    const room = socket.data.room;
    console.log(`[disconnect] ${socket.id} (${socket.data.username || '?'}) motivo: ${reason}`);

    if (room) removeFromRoom(socket, room);
  });
});

const PORT = process.env.PORT || 3000;
// Recupera as salas salvas (se tiver Redis configurado) ANTES de aceitar
// conexão -- sem isso, o primeiro socket a conectar sempre veria a lista de
// salas ainda vazia mesmo se o banco já tivesse salas de verdade.
loadRoomsFromRedis().then(() => {
  server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
});
