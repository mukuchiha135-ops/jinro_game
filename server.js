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
    // 🔐 ユーザー登録
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

    // 🔐 ログイン
    socket.on('loginUser', ({ username, password }) => {
        const user = usersDB[username];
        if (!user || user.password !== password) {
            return socket.emit('authResponse', { success: false, message: 'ユーザー名またはパスワードが正しくありません。' });
        }
        socket.emit('authResponse', { success: true, message: 'ログインに成功しました！', user });
    });

    // 🎮 部屋作成・参加
    socket.on('joinRoom', ({ roomCode, user }) => {
        socket.join(roomCode);
        socket.roomCode = roomCode;

        if (!rooms[roomCode]) {
            rooms[roomCode] = createNewRoom(roomCode, socket.id);
        }

        rooms[roomCode].players[socket.id] = {
            id: socket.id,
            name: user?.username || 'ゲスト',
            avatar: user?.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${socket.id}`,
            role: '市民',
            isAlive: true,
            loverPairId: null // 恋人用ペアID
        };

        io.to(roomCode).emit('updateRoom', rooms[roomCode]);
    });

    // 🎲 ランダム参加
    socket.on('joinRandomRoom', ({ user }) => {
        let targetRoomCode = Object.keys(rooms).find(code => rooms[code].phase === 'lobby');
        if (!targetRoomCode) {
            targetRoomCode = Math.floor(1000 + Math.random() * 9000).toString();
        }

        socket.join(targetRoomCode);
        socket.roomCode = targetRoomCode;

        if (!rooms[targetRoomCode]) {
            rooms[targetRoomCode] = createNewRoom(targetRoomCode, socket.id);
        }

        rooms[targetRoomCode].players[socket.id] = {
            id: socket.id,
            name: user?.username || 'ゲスト',
            avatar: user?.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${socket.id}`,
            role: '市民',
            isAlive: true,
            loverPairId: null
        };

        io.to(targetRoomCode).emit('updateRoom', rooms[targetRoomCode]);
    });

    // 🚀 ゲーム開始（12種類の役職設定を反映）
    socket.on('startGame', ({ customRoles }) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room) return;

        if (room.hostId !== socket.id) {
            return socket.emit('chatMessage', { sender: 'システム', text: 'ゲームを開始できるのはホストのみです。' });
        }

        const playerIds = Object.keys(room.players);
        
        let rolePool = [];
        if (customRoles) {
            for (let i = 0; i < (customRoles.citizen || 0); i++) rolePool.push('市民');
            for (let i = 0; i < (customRoles.wolf || 0); i++) rolePool.push('人狼');
            for (let i = 0; i < (customRoles.seer || 0); i++) rolePool.push('占い師');
            for (let i = 0; i < (customRoles.medium || 0); i++) rolePool.push('霊媒師');
            for (let i = 0; i < (customRoles.guard || 0); i++) rolePool.push('騎士');
            for (let i = 0; i < (customRoles.hunter || 0); i++) rolePool.push('ハンター');
            for (let i = 0; i < (customRoles.lover || 0); i++) rolePool.push('恋人');
            for (let i = 0; i < (customRoles.vampire || 0); i++) rolePool.push('吸血鬼');
            for (let i = 0; i < (customRoles.schizoid || 0); i++) rolePool.push('多重人格者');
            for (let i = 0; i < (customRoles.psycho || 0); i++) rolePool.push('サイコキラー');
            for (let i = 0; i < (customRoles.madman || 0); i++) rolePool.push('狂人');
            for (let i = 0; i < (customRoles.freemason || 0); i++) rolePool.push('共有者');
        }

        if (rolePool.length !== playerIds.length) {
            return socket.emit('chatMessage', { 
                sender: 'システム', 
                text: `役職の合計数（${rolePool.length}枠）と参加人数（${playerIds.length}人）が一致していません。` 
            });
        }

        // シャッフルして配布
        rolePool.sort(() => Math.random() - 0.5);
        
        const loverIds = [];
        playerIds.forEach((id, index) => {
            const role = rolePool[index];
            room.players[id].role = role;
            room.players[id].isAlive = true;
            room.players[id].loverPairId = null;
            if (role === '恋人') loverIds.push(id);
        });

        // 恋人が複数入っている場合、相互リンク設定
        if (loverIds.length >= 2) {
            for (let i = 0; i < loverIds.length; i += 2) {
                if (loverIds[i + 1]) {
                    room.players[loverIds[i]].loverPairId = loverIds[i + 1];
                    room.players[loverIds[i + 1]].loverPairId = loverIds[i];
                }
            }
        }

        room.lastExecutedId = null; // 霊媒師判定用
        io.to(roomCode).emit('gameStarted', room);
        startNightPhase(roomCode);
    });

    // 🌙 夜の行動
    socket.on('nightAction', ({ targetId }) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room || room.phase !== 'night') return;

        room.nightActions[socket.id] = targetId;

        const activeRoles = ['人狼', '占い師', '霊媒師', '騎士', 'サイコキラー'];
        const activeRolePlayers = Object.values(room.players).filter(
            p => p.isAlive && activeRoles.includes(p.role)
        );

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

        const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
        if (Object.keys(room.votes).length >= alivePlayers.length) {
            clearInterval(room.timer);
            processDayResults(roomCode);
        }
    });

    // 🎯 ハンターの道連れ行動
    socket.on('hunterTarget', ({ targetId }) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room || !targetId || !room.players[targetId]) return;

        killPlayer(roomCode, targetId, `${room.players[socket.id].name} (ハンター) の道連れ`);
        
        if (!checkGameOver(roomCode)) {
            if (room.phase === 'night_results_done') startDayPhase(roomCode);
            else if (room.phase === 'day_results_done') startNightPhase(roomCode);
        }
    });

    // 💬 チャット送信（共有者・人狼限定チャット分岐）
    socket.on('sendMessage', ({ text, type }) => {
        const roomCode = socket.roomCode;
        const room = rooms[roomCode];
        if (!room) return;

        const sender = room.players[socket.id];
        if (!sender) return;

        if (type === 'wolf' && sender.role === '人狼') {
            Object.values(room.players).forEach(p => {
                if (p.role === '人狼') {
                    io.to(p.id).emit('chatMessage', { sender: `🐺 ${sender.name}`, text });
                }
            });
        } else if (type === 'freemason' && sender.role === '共有者') {
            Object.values(room.players).forEach(p => {
                if (p.role === '共有者') {
                    io.to(p.id).emit('chatMessage', { sender: `🤝 ${sender.name}`, text });
                }
            });
        } else {
            io.to(roomCode).emit('chatMessage', { sender: sender.name, text });
        }
    });

    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (roomCode && rooms[roomCode]) {
            delete rooms[roomCode].players[socket.id];
            if (rooms[roomCode].hostId === socket.id) {
                const remaining = Object.keys(rooms[roomCode].players);
                if (remaining.length > 0) rooms[roomCode].hostId = remaining[0];
            }
            io.to(roomCode).emit('updateRoom', rooms[roomCode]);
        }
    });
});

function createNewRoom(roomCode, hostId) {
    return {
        id: roomCode,
        hostId: hostId,
        players: {},
        phase: 'lobby',
        timer: null,
        nightActions: {},
        votes: {},
        lastExecutedId: null
    };
}

// 💀 死亡処理 (恋人の道連れ対応)
function killPlayer(roomCode, targetId, reason = "") {
    const room = rooms[roomCode];
    if (!room || !room.players[targetId] || !room.players[targetId].isAlive) return;

    room.players[targetId].isAlive = false;
    io.to(roomCode).emit('chatMessage', { 
        sender: '📢 訃報', 
        text: `${room.players[targetId].name} さんが死亡しました。${reason ? `(${reason})` : ''}` 
    });

    // 恋人の後追い処理
    const loverId = room.players[targetId].loverPairId;
    if (loverId && room.players[loverId] && room.players[loverId].isAlive) {
        killPlayer(roomCode, loverId, "恋人の後追い");
    }
}

// 🏆 勝敗チェック関数 (吸血鬼・人狼・市民・多重人格者・狂人対応)
function checkGameOver(roomCode) {
    const room = rooms[roomCode];
    if (!room) return true;

    const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
    const aliveWolves = alivePlayers.filter(p => p.role === '人狼');
    const aliveVampires = alivePlayers.filter(p => p.role === '吸血鬼');
    
    // 市民陣営判定 (市民, 占い師, 霊媒師, 騎士, ハンター, 恋人, 共有者)
    // 人狼陣営判定 (人狼, 多重人格者, サイコキラー, 狂人)
    const aliveCitizens = alivePlayers.filter(p => !['人狼', '多重人格者', 'サイコキラー', '狂人', '吸血鬼'].includes(p.role));

    // 1. 吸血鬼の単独勝利（人狼全滅かつ最後の生き残り等）
    if (aliveWolves.length === 0 && aliveVampires.length > 0 && aliveCitizens.length === 0) {
        endGame(roomCode, '吸血鬼陣営', '吸血鬼が生き残り、独自陣営の勝利を達成しました！');
        return true;
    }

    // 2. 市民陣営の勝利（人狼全滅）
    if (aliveWolves.length === 0) {
        endGame(roomCode, '市民陣営', '人狼をすべて排除しました！市民陣営の勝利です！');
        return true;
    }

    // 3. 人狼陣営の勝利（人狼の数が市民陣営以上）
    if (aliveWolves.length >= aliveCitizens.length) {
        endGame(roomCode, '人狼陣営', '人狼の人数が優勢になりました！人狼陣営の勝利です！');
        return true;
    }

    return false;
}

function endGame(roomCode, winner, message) {
    const room = rooms[roomCode];
    clearInterval(room.timer);
    room.phase = 'ended';
    io.to(roomCode).emit('gameOver', { winner, message });
}

// 🌙 夜フェーズ開始
function startNightPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room || checkGameOver(roomCode)) return;

    room.phase = 'night';
    room.nightActions = {};
    let timeLeft = 30;

    // 占い師・霊媒師・共有者へ専用情報を個別に送信
    Object.values(room.players).forEach(p => {
        if (!p.isAlive) return;
        
        // 🔮 占い師の結果
        if (p.role === '占い師' && room.nightActions[p.id]) {
            const target = room.players[room.nightActions[p.id]];
            if (target) {
                // 多重人格者は人狼と判定される
                const isWolf = ['人狼', '多重人格者'].includes(target.role);
                io.to(p.id).emit('chatMessage', { sender: '🔮 占い結果', text: `${target.name} さんは 【${isWolf ? '人狼' : '人狼ではない'}】 です。` });
            }
        }
        // 霊媒師の結果
        if (p.role === '霊媒師' && room.lastExecutedId) {
            const target = room.players[room.lastExecutedId];
            if (target) {
                const isWolf = ['人狼', '多重人格者'].includes(target.role);
                io.to(p.id).emit('chatMessage', { sender: '🔮 霊媒結果', text: `昨日追放された ${target.name} さんは 【${isWolf ? '人狼' : '人狼ではない'}】 でした。` });
            }
        }
        // 共有者の相方情報
        if (p.role === '共有者') {
            const partners = Object.values(room.players).filter(other => other.role === '共有者' && other.id !== p.id).map(o => o.name);
            io.to(p.id).emit('chatMessage', { sender: '🤝 共有者仲間', text: partners.length > 0 ? `相方: ${partners.join(', ')}` : '相方は居ません。' });
        }
    });

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

// 朝の集計＆襲撃・護衛・サイコキラー計算
function processNightResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'night_results_done';
    
    const wolfTargets = Object.entries(room.nightActions)
        .filter(([actorId]) => room.players[actorId]?.role === '人狼')
        .map(([, targetId]) => targetId);

    const guardTargets = Object.entries(room.nightActions)
        .filter(([actorId]) => room.players[actorId]?.role === '騎士')
        .map(([, targetId]) => targetId);

    let hunterTriggeredId = null;

    if (wolfTargets.length > 0) {
        const victimId = wolfTargets[0];
        const victim = room.players[victimId];

        // 🛡️ サイコキラー返り討ち（人狼がサイコキラーを襲うと人狼が死ぬ）
        if (victim && victim.role === 'サイコキラー') {
            const wolfId = Object.keys(room.players).find(id => room.players[id].role === '人狼' && room.players[id].isAlive);
            if (wolfId) killPlayer(roomCode, wolfId, "サイコキラーの返り討ち");
        } 
        // 吸血鬼は襲撃耐性あり（死なない）
        else if (victim && victim.role === '吸血鬼') {
            // 無傷
        } 
        // 騎士の護衛成功チェック
        else if (!guardTargets.includes(victimId) && victim && victim.isAlive) {
            killPlayer(roomCode, victimId, "人狼の襲撃");
            if (victim.role === 'ハンター') hunterTriggeredId = victimId;
        }
    }

    if (checkGameOver(roomCode)) return;

    // ハンターの道連れ選択待ち
    if (hunterTriggeredId) {
        io.to(hunterTriggeredId).emit('triggerHunter');
        io.to(roomCode).emit('chatMessage', { sender: '💥 ハンター', text: `${room.players[hunterTriggeredId].name} (ハンター) の道連れ選択を待っています...` });
        return;
    }

    startDayPhase(roomCode);
}

function startDayPhase(roomCode) {
    const room = rooms[roomCode];
    if (!room || checkGameOver(roomCode)) return;

    room.phase = 'day';
    room.votes = {};
    
    io.to(roomCode).emit('startDay', { room });

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

// 昼の集計（追放＆ハンター道連れ判定）
function processDayResults(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'day_results_done';
    const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
    const voteCounts = {};
    let skipVotes = 0;

    Object.values(room.votes).forEach(targetId => {
        if (targetId === 'skip') skipVotes++;
        else voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let executedId = null;
    if (skipVotes <= alivePlayers.length / 2) {
        let maxVotes = 0;
        Object.entries(voteCounts).forEach(([targetId, count]) => {
            if (count > maxVotes) {
                maxVotes = count;
                executedId = targetId;
            }
        });
    }

    if (executedId && room.players[executedId]) {
        room.lastExecutedId = executedId;
        killPlayer(roomCode, executedId, "裁判による追放");

        if (room.players[executedId].role === 'ハンター') {
            io.to(executedId).emit('triggerHunter');
            io.to(roomCode).emit('chatMessage', { sender: '💥 ハンター', text: `${room.players[executedId].name} (ハンター) の道連れ選択を待っています...` });
            return;
        }
    } else {
        io.to(roomCode).emit('chatMessage', { sender: '📢 裁判結果', text: '本日の追放は見送られました。' });
    }

    if (checkGameOver(roomCode)) return;

    startNightPhase(roomCode);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
