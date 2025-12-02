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

/** Genera codice alfanumerico di 6 caratteri univoco. */
function genCode() {
    let c;
    do c = Math.random().toString(36).substr(2, 6).toUpperCase();
    while (tables[c]);
    return c;
}

/** Calcola il punteggio del Blackjack gestendo gli Assi. */
function val(h) {
    let s = 0, a = 0;
    for (const { v } of h) {
        if (v === 1) { s += 11; a++; }
        else s += v >= 11 ? 10 : v;
    }
    while (s > 21 && a > 0) { s -= 10; a--; }
    return s;
}

/** Formatta l'oggetto carta in stringa (es. {v: 11, s: '♥'} -> 'J♥'). */
function fmt(c) {
    const v = CARDS[c.v - 1]; // Usa l'array CARDS per la formattazione
    return `${v}${c.s}`;
}

/** Mescola il mazzo (Fisher-Yates) */
function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.random() * (i + 1) | 0;
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

/** Estrae una carta. Rimescola se il mazzo è vuoto. */
function draw(t) {
    if (!t.d.length) {
        console.log(`⚠️  [${t.code}] Reshuffle`);
        t.d = [];
        for (const s of SUITS) for (let v = 1; v <= 13; v++) t.d.push({ v, s });
        shuffle(t.d);
    }
    return t.d.shift();
}

/** Invia un messaggio a un client specifico. */
function send(client, m) {
    if (client?.readyState === 1) client.send(m);
}

/** Invia un messaggio a tutti i giocatori del tavolo. */
function all(t, m) {
    t.c.forEach(c => send(c, m));
}

/** Attende la risposta del giocatore (o timeout) risolvendo la Promise. */
function resp(client) {
    return new Promise(r => {
        let time = 0;
        const iv = setInterval(() => {
            time += 200;
            if (client?.q.length) {
                clearInterval(iv);
                r(client.q.shift());
            } else if (time >= 30000) {
                clearInterval(iv);
                r("STAND"); // Timeout, il giocatore sta
            }
        }, 200);
    });
}

function join(ws, code) {
    ws.table = code;
    const t = tables[code];
    t.c.push(ws);
    t.h.push([]); // Inizializza mano vuota
    
    // Se è il primo a unirsi, avvia il loop di gioco
    if (!t.run && t.c.length > 0) {
        t.run = true;
        setTimeout(() => game(code), 1000);
    }
}

async function game(code) {
    const t = tables[code];
    if (!t) return;
    t.code = code; // Aggiungi codice per i log

    console.log(`\n🎮 [${code}] Game start`);
    
    // 1. Setup Mazzo e Reset
    t.d = []; // Svuota e riempie il mazzo
    for (const s of SUITS) for (let v = 1; v <= 13; v++) t.d.push({ v, s });
    shuffle(t.d);
    
    t.h = t.c.map(() => []);
    all(t, "DEALER_RESET");
    await wait(300);
    
    // 2. Distribuzione Iniziale (Dealer)
    const dealer = [draw(t), draw(t)];
    all(t, `DEALER_INIT ${fmt(dealer[0])} ${fmt(dealer[1])}`);
    await wait(800);
    
    // 3. Distribuzione Iniziale (Giocatori)
    for (let i = 0; i < t.c.length; i++) {
        t.h[i] = [draw(t), draw(t)];
        send(t.c[i], `CARDS ${t.h[i].map(fmt).join(",")}`);
    }
    await wait(500);
    
    // 4. Turno dei Giocatori
    for (let i = 0; i < t.c.length; i++) {
        if (!t.c[i]) continue;
        console.log(`🎯 [${code}] P${i + 1} turn`);
        
        while (val(t.h[i]) < 21) {
            send(t.c[i], "YOUR_TURN");
            const response = await resp(t.c[i]);
            
            if (response === "HIT") {
                t.h[i].push(draw(t));
                send(t.c[i], `CARDS ${t.h[i].map(fmt).join(",")}`);
                if (val(t.h[i]) > 21) break;
            } else break; // STAND
        }
    }
    
    // 5. Turno del Banco
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
    
    // 6. Calcolo Risultati
    const dv = val(dealer);
    console.log(`🏁 [${code}] Dealer: ${dv}`);
    
    // Invia il risultato *e* l'intera mano finale del dealer
    for (let i = 0; i < t.c.length; i++) {
        const p = val(t.h[i]);
        let res;
        
        if (p > 21) res = "LOSE"; // Sballato
        else if (dv > 21) res = "WIN"; // Dealer sballa
        else if (p > dv) res = "WIN";
        else if (p === dv) res = "PUSH";
        else res = "LOSE";
        
        // Messaggio completo che il client usa per ricostruire la mano del dealer
        send(t.c[i], `RESULT ${res} DEALER ${dealer.map(fmt).join(",")}`);
    }
    await wait(1000);
    
    // 7. Replay – turni ordinati
    const survivors = [];

    for (let i = 0; i < t.c.length; i++) {
        const player = t.c[i];

        // Manda il turno solo al giocatore corrente
        send(player, "PLAY_AGAIN?");

        // Blocca gli altri giocatori
        t.c.forEach((other, idx) => {
            if (idx !== i) send(other, "PLAY_AGAIN_LOCK");
        });

        // Aspetta risposta
        const r = await resp(player);

        if (r === "YES") survivors.push(player);
        else player.close();
    }

    // Aggiorna i giocatori restanti
    t.c = survivors;
    t.h = survivors.map(() => []);

    if (t.c.length > 0) {
        console.log(`♻️  [${code}] Next round`);
        await wait(2000);
        game(code);
    } else {
        console.log(`⏸️  [${code}] Empty, deleting table`);
        delete tables[code];
    }

    
    if (t.c.length > 0) {
        console.log(`♻️  [${code}] Next round`);
        await wait(2000);
        game(code); // Prossima partita
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
        const [cmd, data] = msg.split(' ', 2); // Split in due parti: comando e dati
        
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
            // Comandi di gioco (HIT, STAND, YES) vanno in coda
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
                    console.log(`🗑️  Deleted ${ws.table}`);
                }
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