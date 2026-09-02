const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
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

function getRoomList() {
  return Array.from(rooms.keys()).map(name => ({ name, hasPassword: roomPasswords.has(name) }));
}

function cleanName(raw, maxLen) {
  return (raw || '').toString().trim().slice(0, maxLen);
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update((pw || '').toString()).digest('hex');
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

  socket.on('join-room', ({ roomId, username, avatar, password, ownerToken }) => {
    const isNewRoom = !rooms.has(roomId);

    if (!isNewRoom && roomPasswords.has(roomId)) {
      if (hashPassword(password) !== roomPasswords.get(roomId)) {
        console.log(`[join] ${socket.id} (${username}) errou a senha da sala "${roomId}"`);
        socket.emit('join-error', { reason: 'wrong-password' });
        return;
      }
    }

    if (isNewRoom) {
      rooms.set(roomId, new Set());
      if (password) roomPasswords.set(roomId, hashPassword(password));
    }
    ensureRoomStructures(roomId);
    rooms.get(roomId).add(socket.id);
    socket.join(roomId);
    socket.data.username = cleanName(username, MAX_NAME_LENGTH) || 'Anônimo';
    socket.data.avatar = typeof avatar === 'string' ? avatar : null;
    socket.data.room = roomId;
    socket.data.voiceChannel = null;

    // Dono da sala: quem cria recebe um token secreto (guardado só no cliente
    // dele) que prova a autoria em futuras reconexões — sem isso, qualquer um
    // que entrasse na sala poderia expulsar/renomear à vontade.
    if (isNewRoom) {
      const token = crypto.randomBytes(16).toString('hex');
      roomOwnerTokens.set(roomId, token);
      socket.data.isOwner = true;
      socket.emit('owner-token', { roomId, token });
    } else {
      socket.data.isOwner = !!ownerToken && roomOwnerTokens.get(roomId) === ownerToken;
    }

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

    console.log(`[join] ${socket.id} (${socket.data.username}) entrou na sala "${roomId}"${isNewRoom ? ' (nova sala, virou dono)' : ''}`);
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
    socket.data.avatar = typeof avatar === 'string' && avatar ? avatar : null;
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

    io.to(trimmed).emit('room-renamed', { newName: trimmed });
    io.emit('rooms-update', getRoomList());
    console.log(`[rename] ${socket.id} renomeou a sala "${oldRoom}" pra "${trimmed}"`);
  });

  socket.on('rename-channel', ({ type, oldName, newName }) => {
    if (!socket.data.isOwner) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou renomear um canal sem ser dono`);
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
  });

  socket.on('send-message', ({ channel, text }) => {
    const room = socket.data.room;
    const channels = room ? roomChannels.get(room) : null;
    if (!room || !channels || !channels.text.includes(channel)) return;
    const trimmed = (text || '').toString().slice(0, 2000).trim();
    if (!trimmed) return;

    const msg = {
      id: `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: socket.id,
      userName: socket.data.username,
      text: trimmed,
      ts: Date.now()
    };

    const messages = roomMessages.get(room);
    const list = messages.get(channel);
    if (!list) return;
    list.push(msg);
    if (list.length > MAX_MESSAGES_PER_CHANNEL) list.shift();

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
  });

  socket.on('leave-voice-channel', () => {
    const room = socket.data.room;
    leaveCurrentVoiceChannel(socket);
    if (room) {
      broadcastUserList(room);
      broadcastVoiceChannels(room);
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
    if (!socket.data.isOwner) {
      console.log(`[permissao-negada] ${socket.id} (${socket.data.username}) tentou expulsar sem ser dono`);
      return;
    }
    const room = socket.data.room;
    if (!room || !userId || userId === socket.id) return;
    if (!rooms.get(room)?.has(userId)) return;

    const targetSocket = io.sockets.sockets.get(userId);
    if (!targetSocket) return;
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

  socket.on('offer', ({ target, sdp, caller }) => {
    io.to(target).emit('offer', { caller: socket.id, sdp });
  });

  socket.on('answer', ({ target, sdp, answerer }) => {
    io.to(target).emit('answer', { answerer: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate, sender }) => {
    io.to(target).emit('ice-candidate', { sender: socket.id, candidate });
  });

  socket.on('client-log', ({ level, message }) => {
    console.log(`[client-log:${level || 'info'}] ${socket.data.username || socket.id}: ${String(message).slice(0, 500)}`);
  });

  socket.on('disconnect', (reason) => {
    const room = socket.data.room;
    console.log(`[disconnect] ${socket.id} (${socket.data.username || '?'}) motivo: ${reason}`);
    if (room) {
      leaveCurrentVoiceChannel(socket);

      if (rooms.has(room)) {
        rooms.get(room).delete(socket.id);
        if (rooms.get(room).size === 0) {
          rooms.delete(room);
          roomChannels.delete(room);
          roomVoiceMembers.delete(room);
          roomBroadcasters.delete(room);
          roomMessages.delete(room);
          roomPasswords.delete(room);
          roomOwnerTokens.delete(room);
          io.emit('rooms-update', getRoomList());
        } else {
          broadcastUserList(room);
          broadcastVoiceChannels(room);
          io.to(room).emit('user-disconnected', socket.id);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
