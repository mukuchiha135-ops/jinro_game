const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};

io.on('connection', (socket) => {
    // 1. 部屋作成・入室
    socket.on('joinRoom', ({ roomCode, name, avatar }) => {
        socket.join(roomCode);
        socket.roomCode = roomCode;

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                id: roomCode,
                players: {},
                phase: 'lobby',
                timer: null,
                nightActions: {}
            };
        }

        rooms[roomCode].players[socket.id] = {
            id: socket.id,
            name: name || '名無し',
            avatar: avatar,
            role: '市民',
            isAlive: true
        };

        io.to(roomCode).emit('updateRoom', rooms[roomCode]);
    });

    // 2. クイックジョイン
    socket.on('joinRandomRoom', ({ name, avatar }) => {
        let targetRoomCode = Object.keys(rooms).find(code => rooms[code].phase === 'lobby');
        if (!targetRoomCode) {
            targetRoomCode = Math.floor(1000 + Math.random() * 9000).toString();
        }
        
        socket.join(targetRoomCode);
        socket.roomCode = targetRoomCode;

        if (!rooms[targetRoomCode]) {
            rooms[targetRoomCode] = {
                id: targetRoomCode,
                players: {},
                phase: 'lobby',
                timer: null,
                nightActions: {}
            };
        }

        rooms[targetRoomCode].players[socket.id] = {
            id: socket.id,
            name: name || '名無し',
            avatar: avatar,
            role: '市民',
            isAlive: true
        };

        io.to(targetRoomCode).emit('updateRoom', rooms[targetRoomCode]);
    });

    // 3. ゲーム開始
    socket.on('startGame', () => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room) return;

        const playerIds = Object.keys(room.players);
        const roles = ['人狼', '占い師', '騎士'];
        
        // 役職シャッフル
        playerIds.sort(() => Math.random() - 0.5);

        playerIds.forEach((id, index) => {
            if (index < roles.length) {
                room.players[id].role = roles[index];
            } else {
                room.players[id].role = '市民';
            }
            room.players[id].isAlive = true;
        });

        io.to(roomCode).emit('gameStarted', room);
        startNightPhase(roomCode);
    });

    // 4. 夜の行動受信
    socket.on('nightAction', ({ targetId }) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room || room.phase !== 'night') return;

        room.nightActions[socket.id] = targetId;

        // 夜に行動が必要な生存プレイヤー数
        const activeRolePlayers = Object.values(room.players).filter(
            p => p.isAlive && ['人狼', '占い師', '騎士'].includes(p.role)
        );

        // 全員完了したら即座に夜終了
        if (Object.keys(room.nightActions).length >= activeRolePlayers.length) {
            clearInterval(room.timer);
            processNightResults(roomCode);
        }
    });

    // 5. 💬 チャット処理 (修正完了)
    socket.on('sendMessage', ({ text, type }) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room) return;

        const sender = room.players[socket.id];
        if (!sender) return;

        if (type === 'wolf') {
            if (sender.role === '人狼') {
                Object.values(room.players).forEach(p => {
                    if (p.role === '人狼') {
                        io.to(p.id).emit('chatMessage', { sender: `🐺 ${sender.name}`, text });
                    }
                });
            }
        } else {
            io.to(roomCode).emit('chatMessage', { sender: sender.name, text });
        }
    });

    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            io.to(roomCode).emit('updateRoom', rooms[roomCode]);
        }
    });
});

// 🌙 夜タイマー起動＆進行制御
function startNightPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'night';
    room.nightActions = {};
    let timeLeft = 30; // 30秒カウントダウン

    io.to(roomCode).emit('timerUpdate', { timeLeft });

    clearInterval(room.timer);
    room.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timerUpdate', { timeLeft });

        if (timeLeft <= 0) {
            clearInterval(room.timer);
            processNightResults(roomCode);
        }
    }, 1000);
}

// ☀️ 夜の集計と昼への移行
function processNightResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'day';
    const killedIds = [];

    // 人狼のターゲット決定
    const wolfTargets = Object.entries(room.nightActions)
        .filter(([actorId]) => room.players[actorId]?.role === '人狼')
        .map(([, targetId]) => targetId);

    // 騎士のガード判定
    const guardTargets = Object.entries(room.nightActions)
        .filter(([actorId]) => room.players[actorId]?.role === '騎士')
        .map(([, targetId]) => targetId);

    if (wolfTargets.length > 0) {
        const victimId = wolfTargets[0];
        // 護衛成功チェック
        if (!guardTargets.includes(victimId) && room.players[victimId]) {
            room.players[victimId].isAlive = false;
            killedIds.push(victimId);
        }
    }

    io.to(roomCode).emit('startDay', { room, killedIds });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server executing on http://localhost:${PORT}`);
});
