const express = require('express');
const http = require('http');
const WebSocket = require("ws");
const path = require('path');

// Setup Express e HTTP server
const app = express();
const server = http.createServer(app);

// Serve client.html e assets dalla radice
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.html'));
});

const wss = new WebSocket.Server({ server });

const tables = {};
const MAX_PLAYERS = 5;
const CARDS = Array.from({length: 13}, (_, i) =>
    i === 0 ? 'A' : i < 9 ? String(i + 1) : ['10', 'J', 'Q', 'K'][i - 9]);
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
        const j = Math.random() * (i + 1) | 0;
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function draw(t) {
    if (!t.d.length) {
        console.log(`⚠️  [${t.code}] Reshuffle`);
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

/**
 * resp(client)
 * - attende fino a 30s una risposta nella coda client.q
 * - se il client è chiuso o non risponde risolve con "STAND"
 * - rimuove automaticamente eventuali comandi non validi (timeout safe)
 */
function resp(client) {
    return new Promise(r => {
        if (!client || client.readyState !== 1) return r("STAND");
        let time = 0;
        const iv = setInterval(() => {
            // client might be closed while waiting
            if (!client || client.readyState !== 1) {
                clearInterval(iv);
                return r("STAND");
            }
            if (client.q && client.q.length) {
                clearInterval(iv);
                r(client.q.shift());
            } else if (time >= 30000) {
                clearInterval(iv);
                r("STAND");
            }
            time += 200;
        }, 200);
    });
}

/**
 * join(ws, code)
 * - se la partita è in corso (t.run === true) il client va in t.pending
 * - altrimenti entra in t.c e prende parte alla partita corrente
 */
function join(ws, code) {
    ws.table = code;
    const t = tables[code];

    // Reset coda messaggi per sicurezza
    ws.q = ws.q || [];

    if (!t.run) {
        t.c.push(ws);
        t.h.push([]);
        send(ws, `TABLE_JOINED ${code}`);
    } else {
        // Partita in corso: aggiungilo come pending (partecipante per la prossima mano)
        t.pending.push(ws);
        t.pendingHands.push([]); // placeholder
        send(ws, `TABLE_JOINED ${code}`); // mostra UI al client
        send(ws, `JOINED_WAIT`); // opzionale: messaggio informativo
        console.log(`➕ [${code}] Player joined as pending (will start next round)`);
    }

    // Se è il primo a unirsi e la partita non sta correndo, avvia il loop
    if (!t.run && t.c.length > 0) {
        t.run = true;
        setTimeout(() => game(code), 1000);
    }
}

/**
 * game(code)
 * - ciclo principale della partita
 * - usa t.c come giocatori attivi per la mano
 * - t.pending viene "assorbito" solo dopo la fase di Replay (prima della prossima mano)
 */
async function game(code) {
    const t = tables[code];
    if (!t) return;
    t.code = code;

    console.log(`\n🎮 [${code}] Game start`);

    // Setup mazzo
    t.d = [];
    for (const s of SUITS) for (let v = 1; v <= 13; v++) t.d.push({ v, s });
    shuffle(t.d);

    // Reset mani e invia reset
    t.h = t.c.map(() => []);
    all(t, "DEALER_RESET");
    await wait(300);

    // Dealer iniziale
    const dealer = [draw(t), draw(t)];
    all(t, `DEALER_INIT ${fmt(dealer[0])} ${fmt(dealer[1])}`);
    await wait(800);

    // Distribuzione ai giocatori attivi (solo t.c)
    for (let i = 0; i < t.c.length; i++) {
        if (!t.c[i] || t.c[i].readyState !== 1) continue;
        t.h[i] = [draw(t), draw(t)];
        send(t.c[i], `CARDS ${t.h[i].map(fmt).join(",")}`);
    }
    await wait(500);

    // Turni giocatori (solo t.c)
    for (let i = 0; i < t.c.length; i++) {
        if (!t.c[i] || t.c[i].readyState !== 1) continue;
        console.log(`🎯 [${code}] P${i + 1} turn`);

        while (val(t.h[i]) < 21) {
            send(t.c[i], "YOUR_TURN");
            const response = await resp(t.c[i]);

            // Manages if client closed during its turn
            if (!t.c[i] || t.c[i].readyState !== 1) break;

            if (response === "HIT") {
                t.h[i].push(draw(t));
                send(t.c[i], `CARDS ${t.h[i].map(fmt).join(",")}`);
                if (val(t.h[i]) > 21) break;
            } else break; // STAND or timeout
        }
    }

    // Dealer turn se qualcuno non ha bust
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

    // Calcolo risultati e invio
    const dv = val(dealer);
    console.log(`🏁 [${code}] Dealer: ${dv}`);

    for (let i = 0; i < t.c.length; i++) {
        const client = t.c[i];
        if (!client || client.readyState !== 1) continue;
        const p = val(t.h[i]);
        let res;

        if (p > 21) res = "LOSE";
        else if (dv > 21) res = "WIN";
        else if (p > dv) res = "WIN";
        else if (p === dv) res = "PUSH";
        else res = "LOSE";

        send(client, `RESULT ${res} DEALER ${dealer.map(fmt).join(",")}`);
    }
    await wait(1000);

    // --- Replay sequenziale robusto ---
    // Prima assorbo eventuali pending come "entranti futuri" solo dopo che tutti i PLAY_AGAIN sono stati chiusi
    // Replay: invia sequenzialmente PLAY_AGAIN? agli attivi in t.c; gli altri sono LOCKed

    const survivors = [];

    for (let i = 0; i < t.c.length; i++) {
        const player = t.c[i];

        // Se il client è già scollegato, salta
        if (!player || player.readyState !== 1) continue;

        // Blocca tutti (comunicazione esplicita)
        t.c.forEach((other) => {
            if (other && other.readyState === 1) {
                send(other, "PLAY_AGAIN_LOCK");
            }
        });

        // Ora manda il prompt SOLO al giocatore corrente
        send(player, "PLAY_AGAIN?");

        // Attendi la sua risposta
        const r = await resp(player);

        // Se il client si è chiuso durante l'attesa -> consideralo come NO
        if (!player || player.readyState !== 1) {
            console.log(`❌ [${code}] Player disconnected during replay`);
            continue;
        }

        if (r === "YES") {
            survivors.push(player);
        } else {
            // Chiusura volontaria o timeout -> lo rimuoviamo
            try { player.close(); } catch (e) {}
        }

        // Piccolo delay per consentire sincronia client
        await wait(200);
    }

    // Dopo che tutti i giocatori attivi hanno deciso, assorbo i pending come nuovi partecipanti
    if (t.pending && t.pending.length) {
        console.log(`➕ [${code}] Absorbing ${t.pending.length} pending players into next round`);
        for (const p of t.pending) {
            if (p && p.readyState === 1) {
                survivors.push(p);
            }
        }
        // Svuota pending
        t.pending = [];
        t.pendingHands = [];
    }

    // Riassegno t.c e mani
    t.c = survivors;
    t.h = t.c.map(() => []);

    if (t.c.length > 0) {
        console.log(`♻️  [${code}] Next round with ${t.c.length} players`);
        await wait(2000);
        // riparte il gioco
        game(code);
    } else {
        console.log(`⏸️  [${code}] Empty, deleting table`);
        delete tables[code];
    }
}

// --- GESTIONE WEBSOCKET ---

wss.on("connection", ws => {
    ws.q = []; // Coda messaggi
    ws.table = null;

    ws.on("message", m => {
        const msg = m.toString().trim();
        const [cmd, data] = msg.split(' ', 2);

        if (cmd === "CREATE") {
            const code = genCode();
            tables[code] = { c: [], h: [], d: [], run: false, pending: [], pendingHands: [] };
            join(ws, code);
            send(ws, `TABLE_CREATED ${code}`);
            console.log(`✅ Table ${code} created`);
        } else if (cmd === "JOIN") {
            const code = data;
            if (!tables[code]) send(ws, "TABLE_NOT_FOUND");
            else if ((tables[code].c.length + tables[code].pending.length) >= MAX_PLAYERS) send(ws, "TABLE_FULL");
            else {
                join(ws, code);
                send(ws, `TABLE_JOINED ${code}`);
                console.log(`✅ Joined ${code} (active ${tables[code].c.length} / pending ${tables[code].pending.length})`);
            }
        } else {
            // Comandi di gioco (HIT, STAND, YES) vanno in coda
            // Nota: i client che sono in pending potranno comunque inviare comandi, ma questi verranno
            // considerati solo quando il client verrà assorbito in t.c (evitiamo che disturbino la mano corrente)
            ws.q.push(cmd);
        }
    });

    ws.on("close", () => {
        // Rimuovi da table.c o table.pending se presenti
        if (ws.table && tables[ws.table]) {
            const t = tables[ws.table];

            // rimuovi da active
            const i = t.c.indexOf(ws);
            if (i !== -1) {
                t.c.splice(i, 1);
                t.h.splice(i, 1);
                console.log(`❌ Player left ${ws.table} (active). Remaining active: ${t.c.length}`);
            }

            // rimuovi da pending
            const j = t.pending.indexOf(ws);
            if (j !== -1) {
                t.pending.splice(j, 1);
                t.pendingHands.splice(j, 1);
                console.log(`❌ Player left ${ws.table} (pending). Remaining pending: ${t.pending.length}`);
            }

            // Se il tavolo è vuoto -> cancellalo
            if ((!t.c || t.c.length === 0) && (!t.pending || t.pending.length === 0)) {
                delete tables[ws.table];
                console.log(`🗑️  Deleted ${ws.table}`);
            }
        }
    });
});

// Avvia il server HTTP (e WS)
server.listen(PORT, () => {
    console.log(`🌐 HTTP server listening on port ${PORT}`);
    console.log(`💬 WebSocket server active`);
});

// Alias per Promise basata su timeout
function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}
