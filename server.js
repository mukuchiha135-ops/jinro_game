const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let rooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;

    // 部屋に参加
    socket.on('joinRoom', ({ roomCode, name }) => {
        currentRoom = roomCode;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: {},
                state: 'LOBBY', // LOBBY, NIGHT, DAY, GAME_OVER
                votes: {},
                actions: {},
                timer: null,
                timeLeft: 0,
                loverPairs: [],
                guardedId: null
            };
        }

        rooms[roomCode].players[socket.id] = {
            id: socket.id,
            name: name,
            role: null,
            isAlive: true,
            nightResult: null
        };

        io.to(roomCode).emit('updateRoom', rooms[roomCode]);
    });

    // ゲーム開始
    socket.on('startGame', ({ selectedRoles, dayTimeLimit }) => {
        const room = rooms[currentRoom];
        if (!room) return;

        const playerIds = Object.keys(room.players);
        if (playerIds.length < selectedRoles.length) {
            socket.emit('errorMsg', `参加人数（${playerIds.length}名）より選択された役職枠（${selectedRoles.length}個）が多く設定されています。`);
            return;
        }

        // 不足分は「市民」で埋める
        let roles = [...selectedRoles];
        while (roles.length < playerIds.length) {
            roles.push('市民');
        }

        // シャッフル
        roles.sort(() => Math.random() - 0.5);

        let loversTemp = [];
        playerIds.forEach((id, idx) => {
            room.players[id].role = roles[idx];
            room.players[id].isAlive = true;
            room.players[id].nightResult = null;

            if (roles[idx] === '恋人') {
                loversTemp.push(id);
            }
        });

        room.loverPairs = loversTemp;
        room.state = 'NIGHT';
        room.actions = {};
        room.votes = {};
        room.dayTimeLimit = parseInt(dayTimeLimit) || 180;

        io.to(currentRoom).emit('gameStarted', room);
    });

    // チャット受信 (通常 / 人狼専用 / 共有者専用 / CO)
    socket.on('sendMessage', ({ text, type, isCO }) => {
        const room = rooms[currentRoom];
        if (!room) return;
        const sender = room.players[socket.id];
        if (!sender) return;

        const msgObj = { sender: sender.name, text, type, isCO, role: sender.role };

        if (type === 'wolf' && (sender.role === '人狼' || sender.role === 'サイコキラー')) {
            Object.values(room.players).forEach(p => {
                if (p.role === '人狼' || p.role === 'サイコキラー') {
                    io.to(p.id).emit('chatMessage', msgObj);
                }
            });
        } else if (type === 'share' && sender.role === '共有者') {
            Object.values(room.players).forEach(p => {
                if (p.role === '共有者') {
                    io.to(p.id).emit('chatMessage', msgObj);
                }
            });
        } else {
            io.to(currentRoom).emit('chatMessage', msgObj);
        }
    });

    // 夜の行動処理
    socket.on('nightAction', ({ targetId }) => {
        const room = rooms[currentRoom];
        if (!room || room.state !== 'NIGHT') return;

        const actor = room.players[socket.id];
        room.actions[socket.id] = { role: actor.role, targetId };

        // 占い師能力即時結果
        if (actor.role === '占い師' && targetId) {
            const target = room.players[targetId];
            const isWolf = (target.role === '人狼' || target.role === '多重人格者');
            actor.nightResult = `${target.name} は 【${isWolf ? '人狼' : '人狼ではない'}】 です。`;
            socket.emit('updatePlayerState', actor);
        }

        const actionRoles = ['人狼', 'サイコキラー', '占い師', '騎士（狩人）'];
        const activeActors = Object.values(room.players).filter(p => p.isAlive && actionRoles.includes(p.role));

        if (Object.keys(room.actions).length >= activeActors.length) {
            processNightPhase(room);
        }
    });

    // 夜の集計ロジック（自動GM）
    function processNightPhase(room) {
        let wolfTarget = null;
        let psychoTarget = null;
        let guardTarget = null;

        Object.values(room.actions).forEach(act => {
            if (act.role === '人狼') wolfTarget = act.targetId;
            if (act.role === 'サイコキラー') psychoTarget = act.targetId;
            if (act.role === '騎士（狩人）') guardTarget = act.targetId;
        });

        let killedIds = [];

        if (wolfTarget && wolfTarget !== guardTarget) killedIds.push(wolfTarget);
        if (psychoTarget && psychoTarget !== guardTarget) killedIds.push(psychoTarget);

        killedIds.forEach(id => {
            if (room.players[id]) room.players[id].isAlive = false;
        });

        if (checkWinCondition(room)) return;

        // 昼フェーズに移行 ＆ 自動タイマー開始
        room.state = 'DAY';
        room.votes = {};
        startDayTimer(room);

        io.to(currentRoom).emit('startDay', { room, killedIds, timeLimit: room.dayTimeLimit });
    }

    // 自動タイマーのカウントダウン
    function startDayTimer(room) {
        if (room.timer) clearInterval(room.timer);
        room.timeLeft = room.dayTimeLimit;

        room.timer = setInterval(() => {
            room.timeLeft--;
            io.to(currentRoom).emit('timerUpdate', { timeLeft: room.timeLeft });

            if (room.timeLeft <= 0) {
                clearInterval(room.timer);
                io.to(currentRoom).emit('timeUp');
            }
        }, 1000);
    }

    // 昼の投票
    socket.on('castVote', ({ targetId }) => {
        const room = rooms[currentRoom];
        if (!room || room.state !== 'DAY') return;

        room.votes[socket.id] = targetId;
        const alivePlayers = Object.values(room.players).filter(p => p.isAlive);

        if (Object.keys(room.votes).length >= alivePlayers.length) {
            if (room.timer) clearInterval(room.timer);

            const voteCounts = {};
            Object.values(room.votes).forEach(tId => {
                voteCounts[tId] = (voteCounts[tId] || 0) + 1;
            });

            let executedId = Object.keys(voteCounts).reduce((a, b) => voteCounts[a] > voteCounts[b] ? a : b);

            if (executedId && room.players[executedId]) {
                const executedPlayer = room.players[executedId];
                executedPlayer.isAlive = false;

                // 霊媒師通知
                Object.values(room.players).forEach(p => {
                    if (p.role === '霊媒師' && p.isAlive) {
                        const isWolf = (executedPlayer.role === '人狼' || executedPlayer.role === '多重人格者');
                        p.nightResult = `処刑された ${executedPlayer.name} は 【${isWolf ? '人狼' : '人狼ではない'}】 でした。`;
                        io.to(p.id).emit('updatePlayerState', p);
                    }
                });

                // ハンター道連れ
                if (executedPlayer.role === 'ハンター') {
                    const targets = alivePlayers.filter(p => p.id !== executedId);
                    if (targets.length > 0) {
                        const randomTarget = targets[Math.floor(Math.random() * targets.length)];
                        randomTarget.isAlive = false;
                        io.to(currentRoom).emit('hunterTriggered', { hunterName: executedPlayer.name, targetName: randomTarget.name });
                    }
                }
            }

            if (checkWinCondition(room)) return;

            room.state = 'NIGHT';
            room.actions = {};
            io.to(currentRoom).emit('startNight', { room, executedId });
        }
    });

    // 勝利条件判定（自動GM）
    function checkWinCondition(room) {
        const alive = Object.values(room.players).filter(p => p.isAlive);
        const wolves = alive.filter(p => ['人狼', '多重人格者', 'サイコキラー'].includes(p.role));
        const vampires = alive.filter(p => p.role === '吸血鬼');
        const humans = alive.filter(p => !['人狼', '多重人格者', 'サイコキラー', '吸血鬼'].includes(p.role));

        let winner = null;

        if (wolves.length === 0 || wolves.length >= (humans.length + vampires.length)) {
            if (room.timer) clearInterval(room.timer);
            if (vampires.length > 0) {
                winner = '吸血鬼 (単独陣営)';
            } else if (wolves.length === 0) {
                winner = '市民陣営';
            } else {
                winner = '人狼陣営';
            }
        }

        if (winner) {
            room.state = 'GAME_OVER';
            io.to(currentRoom).emit('gameOver', { winner, room });
            return true;
        }
        return false;
    }

    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            delete rooms[currentRoom].players[socket.id];
            if (Object.keys(rooms[currentRoom].players).length === 0) {
                if (rooms[currentRoom].timer) clearInterval(rooms[currentRoom].timer);
                delete rooms[currentRoom];
            } else {
                io.to(currentRoom).emit('updateRoom', rooms[currentRoom]);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`自動GM搭載・人狼サーバー起動中: http://localhost:${PORT}`);
});