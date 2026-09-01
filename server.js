const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const TEXT_CHANNELS = ['geral', 'off-topic'];
const VOICE_CHANNELS = ['Sala 1', 'Sala 2', 'Sala 3'];
const MAX_MESSAGES_PER_CHANNEL = 200;

const rooms = new Map(); // roomId -> Set de socket ids (todo mundo no servidor/sala)
const roomVoiceMembers = new Map(); // roomId -> Map<canalDeVoz, Set<socketId>>
const roomBroadcasters = new Map(); // roomId -> Map<canalDeVoz, Set<socketId>>
const roomMessages = new Map(); // roomId -> Map<canalDeTexto, Array<mensagem>>

function getRoomList() {
  return Array.from(rooms.keys());
}

function ensureRoomStructures(roomId) {
  if (!roomVoiceMembers.has(roomId)) roomVoiceMembers.set(roomId, new Map());
  if (!roomBroadcasters.has(roomId)) roomBroadcasters.set(roomId, new Map());
  if (!roomMessages.has(roomId)) {
    const m = new Map();
    TEXT_CHANNELS.forEach(c => m.set(c, []));
    roomMessages.set(roomId, m);
  }
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
      voiceChannel,
      isStreaming: voiceChannel ? (broadcasters.get(voiceChannel)?.has(id) || false) : false
    };
  });
  io.to(roomId).emit('update-user-list', users);
}

function broadcastVoiceChannels(roomId) {
  const voiceMembers = roomVoiceMembers.get(roomId) || new Map();
  const payload = {};
  VOICE_CHANNELS.forEach(c => {
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

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('get-rooms', () => {
    socket.emit('rooms-list', getRoomList());
  });

  socket.on('join-room', ({ roomId, username }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    ensureRoomStructures(roomId);
    rooms.get(roomId).add(socket.id);
    socket.join(roomId);
    socket.data.username = username || 'Anônimo';
    socket.data.room = roomId;
    socket.data.voiceChannel = null;

    socket.emit('channels-info', { textChannels: TEXT_CHANNELS, voiceChannels: VOICE_CHANNELS });

    const messages = roomMessages.get(roomId);
    const history = {};
    TEXT_CHANNELS.forEach(c => { history[c] = messages.get(c) || []; });
    socket.emit('chat-history', history);

    broadcastUserList(roomId);
    broadcastVoiceChannels(roomId);

    socket.to(roomId).emit('user-connected', { userId: socket.id, userName: socket.data.username });
    io.emit('rooms-update', getRoomList());
  });

  socket.on('send-message', ({ channel, text }) => {
    const room = socket.data.room;
    if (!room || !TEXT_CHANNELS.includes(channel)) return;
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
    if (!room || !VOICE_CHANNELS.includes(channel)) return;
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

  socket.on('offer', ({ target, sdp, caller }) => {
    io.to(target).emit('offer', { caller: socket.id, sdp });
  });

  socket.on('answer', ({ target, sdp, answerer }) => {
    io.to(target).emit('answer', { answerer: socket.id, sdp });
  });

  socket.on('ice-candidate', ({ target, candidate, sender }) => {
    io.to(target).emit('ice-candidate', { sender: socket.id, candidate });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      leaveCurrentVoiceChannel(socket);

      if (rooms.has(room)) {
        rooms.get(room).delete(socket.id);
        if (rooms.get(room).size === 0) {
          rooms.delete(room);
          roomVoiceMembers.delete(room);
          roomBroadcasters.delete(room);
          roomMessages.delete(room);
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
