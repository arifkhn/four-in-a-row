// server.js
// Run: npm install express socket.io uuid
// Start: node server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
let uuidv4;
try {
  uuidv4 = require("uuid").v4;
} catch (e) {
  console.warn("uuid not installed. Run: npm i uuid  (falling back to random IDs)");
  uuidv4 = () => {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  };
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (landing + public)
app.use(express.static(__dirname));

// Root landing page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "landing.html"));
});

// Game page
app.get("/room/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const SIZE = 8;

// rooms state
const rooms = {}; // rooms[roomId] = { grid, players, roleById, currentPlayer, gameOver }

function createEmptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}
function ensureRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      grid: createEmptyGrid(),
      players: [],
      roleById: {},
      currentPlayer: "black",
      gameOver: false,
    };
  }
  return rooms[roomId];
}

// helper: try to find a room that this socket is part of (one we manage)
function findRoomForSocket(socket) {
  // socket.rooms is a Set containing socket.id and any rooms it joined
  for (const r of socket.rooms) {
    if (r === socket.id) continue;
    if (rooms[r]) return r;
  }
  return null;
}

io.on("connection", (socket) => {
  console.log("[io] connection", socket.id);

  socket.on("createRoom", () => {
    const roomId = (typeof uuidv4 === "function") ? String(uuidv4()).slice(0, 8) : Math.random().toString(36).slice(2, 8);
    ensureRoom(roomId);
    socket.emit("roomCreated", roomId);
    console.log("[createRoom] created", roomId);
  });

  socket.on("joinRoom", (roomId) => {
    if (!roomId) {
      socket.emit("errorMsg", "No room id provided.");
      return;
    }
    const room = ensureRoom(roomId);

    let role;
    if (room.players.length < 2) {
      room.players.push(socket.id);
      role = room.players.length === 1 ? "black" : "white";
      room.roleById[socket.id] = role;
      socket.join(roomId);
      socket.emit("playerAssigned", role);
      io.to(roomId).emit("roomInfo", { playersCount: room.players.length });
      socket.emit("updateFull", { grid: room.grid, currentPlayer: room.currentPlayer, gameOver: room.gameOver });
      console.log(`[joinRoom] ${socket.id} joined ${roomId} as ${role}`);
      if (room.players.length === 2) {
        io.to(roomId).emit("startGame", { roomId });
      }
    } else {
      // spectator
      role = "spectator";
      room.roleById[socket.id] = role;
      socket.join(roomId);
      socket.emit("playerAssigned", role);
      socket.emit("updateFull", { grid: room.grid, currentPlayer: room.currentPlayer, gameOver: room.gameOver });
      io.to(roomId).emit("roomInfo", { playersCount: room.players.length });
      console.log(`[joinRoom] ${socket.id} joined ${roomId} as spectator`);
    }
  });

  // makeMove can receive { roomId, r, c } or just { r, c } (server will infer room)
  socket.on("makeMove", (payload) => {
    if (!payload) return socket.emit("invalid", "Bad move payload");
    let { roomId, r, c } = payload;
    if (!roomId) roomId = findRoomForSocket(socket);
    if (!roomId) return socket.emit("errorMsg", "Room not found for this socket.");

    const room = rooms[roomId];
    if (!room) return socket.emit("errorMsg", "Room does not exist.");
    if (room.gameOver) return socket.emit("invalid", "Game is over.");

    const role = room.roleById[socket.id] || "spectator";
    if (role === "spectator") return socket.emit("invalid", "Spectators cannot play.");
    if (room.currentPlayer !== role) return socket.emit("invalid", "Not your turn.");
    if (typeof r !== "number" || typeof c !== "number") return socket.emit("invalid", "Invalid cell coordinates.");
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return socket.emit("invalid", "Invalid cell.");
    if (room.grid[r][c]) return socket.emit("invalid", "Cell already occupied.");

    room.grid[r][c] = role;
    io.to(roomId).emit("updateBoard", { r, c, player: role });

    if (checkWin(room.grid, r, c)) {
      room.gameOver = true;
      io.to(roomId).emit("gameOver", { winner: role });
      console.log(`[gameOver] room ${roomId} winner ${role}`);
      return;
    }

    room.currentPlayer = (room.currentPlayer === "black") ? "white" : "black";
    io.to(roomId).emit("turn", { currentPlayer: room.currentPlayer });
  });

  // restart(roomId?) - server will infer room if not provided
  socket.on("restart", (roomId) => {
    if (!roomId) roomId = findRoomForSocket(socket);
    if (!roomId) return socket.emit("errorMsg", "Room not found for restart.");
    const room = rooms[roomId];
    if (!room) return;
    room.grid = createEmptyGrid();
    room.currentPlayer = "black";
    room.gameOver = false;
    io.to(roomId).emit("restart", { grid: room.grid, currentPlayer: room.currentPlayer });
    console.log(`[restart] room ${roomId} restarted`);
  });

  socket.on("disconnect", () => {
    console.log("[io] disconnect", socket.id);
    // scan rooms we manage and remove references
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.roleById && room.roleById[socket.id]) {
        // remove player
        room.players = room.players.filter((id) => id !== socket.id);
        delete room.roleById[socket.id];
        io.to(roomId).emit("roomInfo", { playersCount: room.players.length });
        room.gameOver = true;
        io.to(roomId).emit("playerLeft", { id: socket.id });
        console.log(`[disconnect] removed ${socket.id} from ${roomId}`);

        // if room is empty (no sockets in adapter), delete to free memory
        const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
        if (!socketsInRoom || socketsInRoom.size === 0) {
          delete rooms[roomId];
          console.log("[cleanup] deleted empty room", roomId);
        }
      }
    }
  });
});

function checkWin(grid, r, c) {
  const player = grid[r][c];
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    let count = 1;
    let rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && grid[rr][cc] === player) {
      count++; rr += dr; cc += dc;
    }
    rr = r - dr; cc = c - dc;
    while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && grid[rr][cc] === player) {
      count++; rr -= dr; cc -= dc;
    }
    if (count >= 4) return true;
  }
  return false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
