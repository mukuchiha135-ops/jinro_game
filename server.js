const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const usersDB = {};
const rooms = {};

io.on('connection', (socket) => {
    // 🔐 ユーザー登録 / ログイン
    socket.on('registerUser', ({ username, password }) => {
        if (usersDB[username]) {
            return socket.emit('authResponse', { success: false, message: 'このユーザー名は既に使用されています。' });
        }
        usersDB[username] = {
            username,
            password,
            pt: 1000,
            avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`,
            wins: 0,
            losses: 0
        };
        socket.emit('authResponse', { success: true, message: 'アカウントを作成しました！', user: usersDB[username] });
    });

    socket.on('loginUser', ({ username, password }) => {
        const user = usersDB[username];
        if (!user || user.password !== password) {
            return socket.emit('authResponse', { success: false, message: 'ユーザー名またはパスワードが正しくありません。' });
        }
        socket.emit('authResponse', { success: true, message: 'ログインに成功しました！', user });
    });

    // 🎮 部屋入室・作成
    socket.on('joinRoom', ({ roomCode, user }) => {
        socket.join(roomCode);
        socket.roomCode = roomCode;

        if (!rooms[roomCode]) {
            rooms[roomCode] = createNewRoom(roomCode);
        }

        rooms[roomCode].players[socket.id] = {
            id: socket.id,
            name: user?.username || 'ゲスト',
            avatar: user?.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${socket.id}`,
            role: '市民',
            isAlive: true
        };

        io.to(roomCode).emit('updateRoom', rooms[roomCode]);
    });

    socket.on('joinRandomRoom', ({ user }) => {
        let targetRoomCode = Object.keys(rooms).find(code => rooms[code].phase === 'lobby');
        if (!targetRoomCode) {
            targetRoomCode = Math.floor(1000 + Math.random() * 9000).toString();
        }

        socket.join(targetRoomCode);
        socket.roomCode = targetRoomCode;

        if (!rooms[targetRoomCode]) {
            rooms[targetRoomCode] = createNewRoom(targetRoomCode);
        }

        rooms[targetRoomCode].players[socket.id] = {
            id: socket.id,
            name: user?.username || 'ゲスト',
            avatar: user?.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${socket.id}`,
            role: '市民',
            isAlive: true
        };

        io.to(targetRoomCode).emit('updateRoom', rooms[targetRoomCode]);
    });

    // 🚀 ゲーム開始
    socket.on('startGame', () => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room) return;

        const playerIds = Object.keys(room.players);
        if (playerIds.length < 2) return; // プレイヤー数が少ない場合の防止

        const roles = ['人狼', '占い師', '騎士'];
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

    // 🌙 夜の行動
    socket.on('nightAction', ({ targetId }) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room || room.phase !== 'night') return;

        room.nightActions[socket.id] = targetId;

        // 生きている能力者の数を取得
        const activeRolePlayers = Object.values(room.players).filter(
            p => p.isAlive && ['人狼', '占い師', '騎士'].includes(p.role)
        );

        // 生存している能力者全員が行動したら即夜を終了
        if (Object.keys(room.nightActions).length >= activeRolePlayers.length) {
            clearInterval(room.timer);
            processNightResults(roomCode);
        }
    });

    // 🗳️ 昼の投票行動
    socket.on('castVote', ({ targetId }) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room || room.phase !== 'day') return;

        room.votes[socket.id] = targetId;

        // 生存者全員が投票したら即昼を終了
        const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
        if (Object.keys(room.votes).length >= alivePlayers.length) {
            clearInterval(room.timer);
            processDayResults(roomCode);
        }
    });

    // 💬 チャット送信
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

function createNewRoom(roomCode) {
    return {
        id: roomCode,
        players: {},
        phase: 'lobby',
        timer: null,
        nightActions: {},
        votes: {}
    };
}

// 🏆 勝敗チェック関数
function checkGameOver(roomCode) {
    const room = rooms[roomCode];
    if (!room) return true;

    const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
    const aliveWolves = alivePlayers.filter(p => p.role === '人狼');
    const aliveCitizens = alivePlayers.filter(p => p.role !== '人狼');

    // 1. 人狼が全滅した場合 -> 市民陣営の勝利
    if (aliveWolves.length === 0) {
        clearInterval(room.timer);
        room.phase = 'ended';
        io.to(roomCode).emit('gameOver', { winner: '市民陣営', message: '人狼を全滅させました！市民陣営の勝利です！' });
        return true;
    }

    // 2. 人狼の数が市民と同数以上になった場合 -> 人狼陣営の勝利
    if (aliveWolves.length >= aliveCitizens.length) {
        clearInterval(room.timer);
        room.phase = 'ended';
        io.to(roomCode).emit('gameOver', { winner: '人狼陣営', message: '人狼の数が市民と同数以上になりました。人狼陣営の勝利です！' });
        return true;
    }

    return false;
}

// 🌙 夜フェーズ開始
function startNightPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    if (checkGameOver(roomCode)) return;

    room.phase = 'night';
    room.nightActions = {};
    let timeLeft = 30;

    io.to(roomCode).emit('startNight', { room });
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

// 朝の集計＆昼フェーズ開始
function processNightResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'day';
    room.votes = {};
    const killedIds = [];

    const wolfTargets = Object.entries(room.nightActions)
        .filter(([actorId]) => room.players[actorId]?.role === '人狼')
        .map(([, targetId]) => targetId);

    const guardTargets = Object.entries(room.nightActions)
        .filter(([actorId]) => room.players[actorId]?.role === '騎士')
        .map(([, targetId]) => targetId);

    if (wolfTargets.length > 0) {
        const victimId = wolfTargets[0];
        if (!guardTargets.includes(victimId) && room.players[victimId]) {
            room.players[victimId].isAlive = false;
            killedIds.push(victimId);
        }
    }

    // 犠牲者判定後の勝敗チェック
    if (checkGameOver(roomCode)) return;

    io.to(roomCode).emit('startDay', { room, killedIds });

    // ☀️ 昼タイマーのスタート (60秒)
    let timeLeft = 60;
    io.to(roomCode).emit('timerUpdate', { timeLeft });

    clearInterval(room.timer);
    room.timer = setInterval(() => {
        timeLeft--;
        io.to(roomCode).emit('timerUpdate', { timeLeft });

        if (timeLeft <= 0) {
            clearInterval(room.timer);
            processDayResults(roomCode);
        }
    }, 1000);
}

// 昼の集計（投票結果の反映）
function processDayResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    const voteCounts = {};
    Object.values(room.votes).forEach(targetId => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let maxVotes = 0;
    let executedId = null;

    Object.entries(voteCounts).forEach(([targetId, count]) => {
        if (count > maxVotes) {
            maxVotes = count;
            executedId = targetId;
        }
    });

    if (executedId && room.players[executedId]) {
        room.players[executedId].isAlive = false;
    }

    // 処刑後の勝敗チェック
    if (checkGameOver(roomCode)) return;

    // ゲームが継続する場合は次の夜フェーズへ
    startNightPhase(roomCode);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
