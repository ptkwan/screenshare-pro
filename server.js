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

const rooms = new Map(); // roomId -> Set de socket ids
const roomBroadcasters = new Map(); // roomId -> Set de socket ids dos streamers

function getRoomList() {
  return Array.from(rooms.keys());
}

// NOVA FUNÇÃO: Junta a lista de usuários com o status de "Ao Vivo"
function broadcastUserList(roomId) {
  if (!rooms.has(roomId)) return;
  const users = Array.from(rooms.get(roomId)).map(id => ({
    id,
    name: io.sockets.sockets.get(id)?.data.username || 'Anônimo',
    // O servidor agora diz pro HTML diretamente se esse usuário está compartilhando
    isStreaming: roomBroadcasters.get(roomId)?.has(id) || false 
  }));
  io.to(roomId).emit('update-user-list', users);
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
    rooms.get(roomId).add(socket.id);
    socket.join(roomId);
    socket.data.username = username || 'Anônimo';
    socket.data.room = roomId;

    // Dispara a lista unificada para todos na sala
    broadcastUserList(roomId);
    
    socket.to(roomId).emit('user-connected', { userId: socket.id, userName: socket.data.username });
    io.emit('rooms-update', getRoomList());
  });

  socket.on('start-sharing', () => {
    const room = socket.data.room;
    if (room) {
      if (!roomBroadcasters.has(room)) {
        roomBroadcasters.set(room, new Set());
      }
      roomBroadcasters.get(room).add(socket.id);
      
      broadcastUserList(room); // Atualiza as telas de todos para mostrar o botão "ASSISTIR"
      io.to(room).emit('broadcaster-started', { userId: socket.id });
    }
  });

  socket.on('stop-sharing', () => {
    const room = socket.data.room;
    if (room && roomBroadcasters.has(room)) {
      roomBroadcasters.get(room).delete(socket.id);
      if (roomBroadcasters.get(room).size === 0) {
        roomBroadcasters.delete(room);
      }
      
      broadcastUserList(room); // Remove o botão "ASSISTIR" desse usuário
      io.to(room).emit('broadcaster-stopped', { userId: socket.id });
    }
  });

  socket.on('request-stream', ({ userId }) => {
    const room = socket.data.room;
    if (room && roomBroadcasters.has(room) && roomBroadcasters.get(room).has(userId)) {
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
      if (roomBroadcasters.has(room)) {
        roomBroadcasters.get(room).delete(socket.id);
        if (roomBroadcasters.get(room).size === 0) {
          roomBroadcasters.delete(room);
        }
      }
      if (rooms.has(room)) {
        rooms.get(room).delete(socket.id);
        if (rooms.get(room).size === 0) {
          rooms.delete(room);
          io.emit('rooms-update', getRoomList());
        } else {
          broadcastUserList(room);
          io.to(room).emit('user-disconnected', socket.id);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));