// server.js
// -------------------------
// Server Web (HTTP + WebSocket) per il gioco Blackjack
//
// Macro-sezioni:
//  - Setup e costanti
//  - Utility e formattazione
//  - Gestione tavoli / join
//  - Loop di gioco (game)
//  - WebSocket handler
// -------------------------

const express = require('express');
const http = require('http');
const WebSocket = require("ws");
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// -------------------------
// Config & costanti
// -------------------------
const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 5;
const SUITS = ["♥", "♦", "♣", "♠"];
const CARDS = Array.from({ length: 13 }, (_, i) => i === 0 ? 'A' : i < 9 ? String(i + 1) : ['10', 'J', 'Q', 'K'][i - 9]);

// Stato dei tavoli in memoria: tables[code] = { c: [ws], h: [hands], d: deck, run: bool }
const tables = {};

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'client.html')));

console.log(`🎰 Server starting on port ${PORT}...`);

// -------------------------
// Utility e funzioni di supporto
// -------------------------

/* genCode
   - Genera un codice tavolo unico di 6 caratteri (A-Z0-9)
*/
function genCode() {
    let c;
    do c = Math.random().toString(36).substr(2, 6).toUpperCase();
    while (tables[c]);
    return c;
}

/* val
   - Calcola il valore di una mano (array di oggetti {v,s})
   - A = 11 o 1 (gestione degli assi)
*/
function val(hand) {
    if (!hand || !Array.isArray(hand)) {
        console.error('val: expected an array for hand but got:', hand);
        return 0;
    }

    let s = 0, a = 0;
    for (const card of hand) {
        const v = card && card.v;
        if (v === 1) { s += 11; a++; }                  // Asso
        else s += v >= 11 ? 10 : v;                    // J/Q/K = 10
    }
    while (s > 21 && a > 0) { s -= 10; a--; }
    return s;
}

/* fmt
   - Formatta una carta {v,s} in stringa leggibile (es. "J♠", "10♥", "A♦")
*/
function fmt(card) {
    const v = CARDS[card.v - 1];
    return `${v}${card.s}`;
}

/* shuffle
   - Fisher-Yates shuffle in-place
*/
function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

/* draw
   - Estrae una carta dal mazzo del tavolo, rimescola se il mazzo è vuoto
*/
function draw(table) {
    if (!table.d.length) {
        // Ricostruzione mazzo
        table.d = [];
        for (const s of SUITS) for (let v = 1; v <= 13; v++) table.d.push({ v, s });
        shuffle(table.d);
        console.log(`⚠️ [${table.code}] Reshuffle`);
    }
    return table.d.shift();
}

/* send / all
   - Invia messaggi WebSocket gestendo readyState
*/
function send(client, m) {
    if (client?.readyState === 1) client.send(m);
}
function all(table, m) {
    table.c.forEach(c => send(c, m));
}

/* resp
   - Attende la risposta del client leggendo la sua queue (ws.q)
   - Timeout 30s -> auto STAND
   - Se client chiuso -> STAND
*/
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

/* getActivePlayers
   - Restituisce gli indici dei giocatori attivi (mano non vuota)
*/
function getActivePlayers(table) {
    return table.h.map((hand, i) => hand.length > 0 ? i : -1).filter(i => i !== -1);
}

/* wait (sleep async) */
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// -------------------------
// Gestione join / tavoli
// -------------------------

/* join
   - Aggiunge ws al tavolo specificato
   - Se la partita è in corso, il giocatore entra in "waiting mode" (parte dopo)
*/
function join(ws, code) {
    ws.table = code;
    const t = tables[code];

    if (t.run) {
        // partita in corso -> modalità attesa
        send(ws, "PLAY_AGAIN_LOCK");
        t.c.push(ws);
        t.h.push([]); // mano vuota = parteciperà al prossimo round
        console.log(`👀 Player joined ${code} in waiting mode`);
    } else {
        t.c.push(ws);
        t.h.push([]);
        if (!t.run && t.c.length > 0) {
            t.run = true;
            setTimeout(() => game(code), 1000); // avvia gioco con breve delay
        }
    }
}

// -------------------------
// Loop principale di gioco (game)
// -------------------------
// Struttura generale:
// 1) setup mazzo + reset UI via DEALER_RESET
// 2) distribuzione iniziale dealer (DEALER_INIT)
// 3) distribuzione iniziale player (CARDS)
// 4) turno giocatori (YOUR_TURN -> HIT/STAND via resp)
// 5) turno dealer (DEALER_REVEAL, DEALER_CARD)
// 6) calcolo risultati e invio RESULT
// 7) gestione PLAY_AGAIN (risposte parallele)
// -------------------------

async function game(code) {
    const t = tables[code];
    if (!t) return;
    t.code = code;

    console.log(`\n🎮 [${code}] Game start with ${t.c.length} players`);

    // 1) Setup mazzo e reset stato
    t.d = [];
    for (const s of SUITS) for (let v = 1; v <= 13; v++) t.d.push({ v, s });
    shuffle(t.d);
    all(t, "DEALER_RESET");
    await wait(300);

    // 2) Distribuzione iniziale dealer (2 carte)
    const dealer = [draw(t), draw(t)];
    all(t, `DEALER_INIT ${fmt(dealer[0])} ${fmt(dealer[1])}`);
    await wait(800);

    // 3) Distribuzione iniziale ai giocatori attivi (chi ha mano vuota)
    for (let i = 0; i < t.c.length; i++) {
        if (t.h[i].length !== 0) continue; // skip chi è entrato in ritardo
        t.h[i] = [draw(t), draw(t)];
        send(t.c[i], `CARDS ${t.h[i].map(fmt).join(",")}`);
    }
    await wait(500);

    // 4) Turno giocatori (uno a uno)
    const activeIndices = getActivePlayers(t);
    for (let idx of activeIndices) {
        console.log(`🎯 [${code}] P${idx + 1} turn`);
        while (val(t.h[idx]) < 21) {
            send(t.c[idx], "YOUR_TURN");
            const response = await resp(t.c[idx]); // attende HIT/STAND da client (o timeout)
            if (response === "HIT") {
                t.h[idx].push(draw(t));
                send(t.c[idx], `CARDS ${t.h[idx].map(fmt).join(",")}`);
                if (val(t.h[idx]) > 21) break; // busted
            } else break; // STAND o altro -> passo al prossimo
        }
    }

    // 5) Turno dealer
    const anyAlive = activeIndices.some(i => val(t.h[i]) <= 21);
    if (anyAlive) {
        console.log(`🎲 [${code}] Dealer turn`);
        all(t, "DEALER_REVEAL"); // riveliamo la carta coperta del dealer ai client
        await wait(1000);
        while (val(dealer) < 17 && activeIndices.some(i => val(t.h[i]) <= 21)) {
            await wait(800);
            dealer.push(draw(t));
            all(t, `DEALER_CARD ${fmt(dealer[dealer.length - 1])}`);
        }
    } else {
        // tutti busted -> riveliamo comunque la carta coperta
        console.log(`💥 [${code}] All bust`);
        all(t, "DEALER_REVEAL");
        await wait(1000);
    }

    // 6) Calcolo risultati e invio a ciascun giocatore attivo
    const dv = val(dealer);
    console.log(`🏁 [${code}] Dealer: ${dv}`);
    for (let i of activeIndices) {
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

    // 7) Replay: chiediamo a tutti se vogliono giocare ancora
    console.log(`⏳ [${code}] Asking all players for replay...`);
    all(t, "PLAY_AGAIN?");
    // reset queues prima di raccogliere le risposte
    t.c.forEach(ws => ws.q = []);
    // attendiamo risposte in parallelo (resp gestisce timeout/close)
    const responses = await Promise.all(t.c.map(ws => resp(ws)));
    console.log(`📊 [${code}] Responses:`, responses);

    // costruzione lista dei partecipanti per il prossimo round
    const nextClients = [];
    for (let i = 0; i < t.c.length; i++) {
        if (responses[i] === "YES") {
            nextClients.push(t.c[i]);
            console.log(`✅ [${code}] Player ${i + 1} wants to replay`);
        } else {
            console.log(`❌ [${code}] Player ${i + 1} left`);
            t.c[i].close();
        }
    }

    // aggiorniamo stato tavolo
    t.c = nextClients;
    t.h = nextClients.map(() => []);

    if (t.c.length > 0) {
        console.log(`♻️ [${code}] Next round with ${t.c.length} players`);
        await wait(2000);
        game(code); // ricomincia loop
    } else {
        console.log(`⏸️ [${code}] Empty, deleting table`);
        t.run = false;
        delete tables[code];
    }
}

// -------------------------
// WebSocket handler
// -------------------------

wss.on("connection", ws => {
    // micro: inizializzazione minima per ogni client
    ws.q = [];        // queue locale delle risposte dal client
    ws.table = null;  // codice del tavolo a cui è connesso

    ws.on("message", m => {
        const msg = m.toString().trim();
        const [cmd, data] = msg.split(' ', 2);

        // Comandi di creazione/join (senza dipendenze dallo stato del tavolo)
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
            // Comandi di gioco: dobbiamo avere un tavolo assegnato
            if (!ws.table) return;
            const t = tables[ws.table];
            const i = t.c.indexOf(ws);

            // YES (play again) è accettato anche da chi è in waiting
            if (cmd === "YES") {
                ws.q.push(cmd);
                console.log(`🔔 [${ws.table}] Player ${i + 1} responded YES`);
            } else {
                // altri comandi (HIT/STAND) solo da player attivi (i !== -1 e mano non vuota)
                if (i === -1 || t.h[i].length === 0) return;
                ws.q.push(cmd);
            }
        }
    });

    // gestione disconnessione: rimozione dal tavolo e possibile cleanup
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

// Avvio server HTTP + WS
server.listen(PORT, () => {
    console.log(`🌐 HTTP server listening on port ${PORT}`);
    console.log(`💬 WebSocket server active`);
});
