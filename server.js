const express = require('express');
const http = require('http');
const WebSocket = require("ws");
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
});

const wss = new WebSocket.Server({ server });

const tables = {};
const MAX_PLAYERS = 5;
const CARDS = Array.from({ length: 13 }, (_, i) => i === 0 ? 'A' : i < 9 ? String(i + 1) : ['10', 'J', 'Q', 'K'][i - 9]);
const SUITS = ["♥", "♦", "♣", "♠"];
const PORT = process.env.PORT || 8080;

console.log(`🎰 Server starting on port ${PORT}...`);

// --- UTILITY E LOGICA DI GIOCO ---

function genCode() {
    let c;
    do c = Math.random().toString(36).substr(2, 6).toUpperCase();
    while (tables[c]);
    return c;
}

function val(h) {
    let s = 0, a = 0;
    for (const { v } of h) {
        if (v === 1) { s += 11; a++; }
        else s += v >= 11 ? 10 : v;
    }
    while (s > 21 && a > 0) { s -= 10; a--; }
    return s;
}

function fmt(c) {
    const v = CARDS[c.v - 1];
    return `${v}${c.s}`;
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function draw(t) {
    if (!t.d.length) {
        console.log(`⚠️ [${t.code}] Reshuffle`);
        t.d = [];
        for (const s of SUITS) for (let v = 1; v <= 13; v++) t.d.push({ v, s });
        shuffle(t.d);
    }
    return t.d.shift();
}

function send(client, m) {
    if (client?.readyState === 1) client.send(m);
}

function all(t, m) {
    t.c.forEach(c => send(c, m));
}

function resp(client) {
    return new Promise(r => {
        let time = 0;
        const iv = setInterval(() => {
            if (!client || client.readyState !== 1) { clearInterval(iv); r("STAND"); return; }
            time += 200;
            if (client.q.length) { clearInterval(iv); r(client.q.shift()); }
            else if (time >= 30000) { clearInterval(iv); r("STAND"); }
        }, 200);
    });
}

// --- GESTIONE CLIENT CHE SI UNISCONO ---

function join(ws, code) {
    ws.table = code;
    const t = tables[code];

    if (t.run) {
        // Partita in corso: nuovo client in modalità "attesa"
        send(ws, "PLAY_AGAIN_LOCK");
        t.c.push(ws);
        t.h.push([]); // mano vuota, parteciperà al prossimo round
        console.log(`👀 Player joined ${code} in waiting mode`);
    } else {
        t.c.push(ws);
        t.h.push([]);
        if (!t.run && t.c.length > 0) {
            t.run = true;
            setTimeout(() => game(code), 1000);
        }
    }
}

// --- LOOP DI GIOCO ---

async function game(code) {
    const t = tables[code];
    if (!t) return;
    t.code = code;

    console.log(`\n🎮 [${code}] Game start`);

    // 1. Setup mazzo e reset
    t.d = [];
    for (const s of SUITS) for (let v = 1; v <= 13; v++) t.d.push({ v, s });
    shuffle(t.d);
    t.h = t.c.map(c => c.q.length > 0 || c.table === code ? [] : []); // solo vecchi client avranno mano vera
    all(t, "DEALER_RESET");
    await wait(300);

    // 2. Distribuzione iniziale dealer
    const dealer = [draw(t), draw(t)];
    all(t, `DEALER_INIT ${fmt(dealer[0])} ${fmt(dealer[1])}`);
    await wait(800);

    // 3. Distribuzione iniziale giocatori (solo chi ha mano vuota non è in attesa)
    for (let i = 0; i < t.c.length; i++) {
        if (t.h[i].length !== 0) continue; // skip player entrato in ritardo
        t.h[i] = [draw(t), draw(t)];
        send(t.c[i], `CARDS ${t.h[i].map(fmt).join(",")}`);
    }
    await wait(500);

    // 4. Turno giocatori
    for (let i = 0; i < t.c.length; i++) {
        if (!t.h[i] || t.h[i].length === 0) continue; // player in attesa
        console.log(`🎯 [${code}] P${i + 1} turn`);
        while (val(t.h[i]) < 21) {
            send(t.c[i], "YOUR_TURN");
            const response = await resp(t.c[i]);
            if (response === "HIT") {
                t.h[i].push(draw(t));
                send(t.c[i], `CARDS ${t.h[i].map(fmt).join(",")}`);
                if (val(t.h[i]) > 21) break;
            } else break;
        }
    }

    // 5. Turno dealer
    const anyAlive = t.h.some(h => val(h) <= 21);
    if (anyAlive) {
        console.log(`🎲 [${code}] Dealer turn`);
        all(t, "DEALER_REVEAL");
        await wait(1000);
        while (val(dealer) < 17) {
            await wait(800);
            dealer.push(draw(t));
            all(t, `DEALER_CARD ${fmt(dealer[dealer.length - 1])}`);
        }
    } else {
        console.log(`💥 [${code}] All bust`);
        all(t, "DEALER_REVEAL");
        await wait(1000);
    }

    // 6. Calcolo risultati
    const dv = val(dealer);
    console.log(`🏁 [${code}] Dealer: ${dv}`);
    for (let i = 0; i < t.c.length; i++) {
        if (!t.h[i] || t.h[i].length === 0) continue; // player in attesa
        const p = val(t.h[i]);
        let res;
        if (p > 21) res = "LOSE";
        else if (dv > 21) res = "WIN";
        else if (p > dv) res = "WIN";
        else if (p === dv) res = "PUSH";
        else res = "LOSE";
        send(t.c[i], `RESULT ${res} DEALER ${dealer.map(fmt).join(",")}`);
    }

    await wait(1000);

    // 7. Replay
    const nextClients = [];
    for (let i = 0; i < t.c.length; i++) {
        if (!t.c[i]) continue;
        send(t.c[i], "PLAY_AGAIN?");
        if (await resp(t.c[i]) === "YES") nextClients.push(t.c[i]);
        else t.c[i].close();
    }
    t.c = nextClients;
    t.h = nextClients.map(() => []);
    if (t.c.length > 0) {
        console.log(`♻️ [${code}] Next round`);
        await wait(2000);
        game(code);
    } else {
        console.log(`⏸️ [${code}] Empty, deleting table`);
        delete tables[code];
    }
}

// --- GESTIONE WEBSOCKET ---
wss.on("connection", ws => {
    ws.q = [];
    ws.table = null;

    ws.on("message", m => {
        const msg = m.toString().trim();
        const [cmd, data] = msg.split(' ', 2);

        if (cmd === "CREATE") {
            const code = genCode();
            tables[code] = { c: [], h: [], d: [], run: false };
            join(ws, code);
            send(ws, `TABLE_CREATED ${code}`);
            console.log(`✅ Table ${code} created`);
        } else if (cmd === "JOIN") {
            const code = data;
            if (!tables[code]) send(ws, "TABLE_NOT_FOUND");
            else if (tables[code].c.length >= MAX_PLAYERS) send(ws, "TABLE_FULL");
            else {
                join(ws, code);
                send(ws, `TABLE_JOINED ${code}`);
                console.log(`✅ Joined ${code} (${tables[code].c.length}/${MAX_PLAYERS})`);
            }
        } else {
            if (!ws.table) return;
            const t = tables[ws.table];
            const i = t.c.indexOf(ws);
            if (i === -1 || t.h[i].length === 0) return; // ignora comandi dei nuovi player in attesa
            ws.q.push(cmd);
        }
    });

    ws.on("close", () => {
        if (ws.table && tables[ws.table]) {
            const t = tables[ws.table];
            const i = t.c.indexOf(ws);
            if (i !== -1) {
                t.c.splice(i, 1);
                t.h.splice(i, 1);
                console.log(`❌ Player left ${ws.table} (${t.c.length} remaining)`);
                if (t.c.length === 0) {
                    delete tables[ws.table];
                    console.log(`🗑️ Deleted ${ws.table}`);
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`🌐 HTTP server listening on port ${PORT}`);
    console.log(`💬 WebSocket server active`);
});

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
