// server.js
// Run: npm init -y && npm install express socket.io
// Start: node server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static client
app.use(express.static(path.join(__dirname, "landing.html")));

// Serve landing page at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "landing.html"));
});

// Serve game page for any room
app.get("/room/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const SIZE = 8;

let grid = createEmptyGrid();
let players = []; // array of socket ids (max 2)
let roleById = {}; // socketId -> 'black' | 'white' | 'spectator'
let currentPlayer = "black"; // whose turn it is: 'black' or 'white'
let gameOver = false;

function createEmptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

io.on("connection", (socket) => {
  console.log("Connection:", socket.id);

  // Assign role
  if (players.length < 2) {
    players.push(socket.id);
    const role = players.length === 1 ? "black" : "white";
    roleById[socket.id] = role;
    socket.emit("playerAssigned", role);
    console.log(`Assigned ${role} to ${socket.id}`);
  } else {
    roleById[socket.id] = "spectator";
    socket.emit("playerAssigned", "spectator");
    console.log(`Assigned spectator to ${socket.id}`);
  }

  // Send initial state for client to render
  socket.emit("gameState", {
    grid,
    currentPlayer,
    players: {
      black: players[0] || null,
      white: players[1] || null,
    },
    gameOver,
  });

  // Broadcast player list update
  io.emit("playerList", {
    black: players[0] || null,
    white: players[1] || null,
  });

  // Handle move from client
  socket.on("makeMove", ({ r, c }) => {
    if (gameOver) return;

    const role = roleById[socket.id];
    if (!role || (role !== "black" && role !== "white")) {
      // spectators cannot move
      socket.emit("invalid", "Spectators cannot play.");
      return;
    }

    // Must be this player's turn
    if (role !== currentPlayer) {
      socket.emit("invalid", "Not your turn.");
      return;
    }

    // Bounds check
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) {
      socket.emit("invalid", "Invalid cell.");
      return;
    }

    // Gravity rule: can place only if bottom row OR below cell is filled
    if (r < SIZE - 1 && !grid[r + 1][c]) {
      socket.emit("invalid", "You can only place on bottom or on top of another piece.");
      return;
    }

    // Occupied?
    if (grid[r][c]) {
      socket.emit("invalid", "Cell already occupied.");
      return;
    }

    // Place piece
    grid[r][c] = role;
    io.emit("updateBoard", { r, c, player: role });

    // Check win
    if (checkWin(r, c)) {
      gameOver = true;
      io.emit("gameOver", { winner: role });
      console.log("Winner:", role);
      return;
    }

    // Toggle turn
    currentPlayer = currentPlayer === "black" ? "white" : "black";
    io.emit("turnChange", currentPlayer);
  });

  socket.on("restart", () => {
    // either player (or server) can request restart
    resetGame();
    io.emit("gameState", {
      grid,
      currentPlayer,
      players: {
        black: players[0] || null,
        white: players[1] || null,
      },
      gameOver,
    });
  });

  socket.on("disconnect", () => {
    console.log("Disconnect:", socket.id);
    const idx = players.indexOf(socket.id);
    if (idx !== -1) {
      // remove player
      players.splice(idx, 1);
    }
    delete roleById[socket.id];

    // Reset everything on disconnect for simplicity
    resetGame();
    io.emit("playerList", {
      black: players[0] || null,
      white: players[1] || null,
    });
    io.emit("gameState", {
      grid,
      currentPlayer,
      players: {
        black: players[0] || null,
        white: players[1] || null,
      },
      gameOver,
    });
  });
});

function resetGame() {
  grid = createEmptyGrid();
  currentPlayer = "black";
  gameOver = false;
  console.log("Game reset.");
}

function checkWin(row, col) {
  const dirs = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    let cnt = 1 + countSame(row, col, dr, dc) + countSame(row, col, -dr, -dc);
    if (cnt >= 4) return true;
  }
  return false;
}

function countSame(r, c, dr, dc) {
  let cnt = 0;
  const player = grid[r][c];
  let rr = r + dr,
    cc = c + dc;
  while (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE && grid[rr][cc] === player) {
    cnt++;
    rr += dr;
    cc += dc;
  }
  return cnt;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
