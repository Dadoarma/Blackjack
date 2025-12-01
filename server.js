// SERVER BLACKJACK CON HTTP + WEBSOCKET
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// Setup Express e HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve file statici dalla cartella 'public'
// Questo serve il file 'public/index.html' come pagina principale
app.use(express.static('public'));

// Tavoli attivi
const tavoli = new Map();

// Mazzo di carte
const CARTE = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEMI = ['♠', '♥', '♦', '♣'];

// Genera mazzo e lo mescola
function mazzo() {
    const m = [];
    for (let s of SEMI) for (let c of CARTE) m.push(c + s);
    return m.sort(() => Math.random() - 0.5);
}

// Genera codice tavolo di 6 caratteri
function codice() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Calcola punteggio del Blackjack (gestisce gli Assi come 1 o 11)
function punteggio(carte) {
    let s = 0, a = 0;
    for (let c of carte) {
        const v = c.slice(0, -1);
        if (v === 'A') { s += 11; a++; }
        else s += ['J', 'Q', 'K'].includes(v) ? 10 : +v;
    }
    // Riduci il valore degli Assi se si sballa (oltre 21)
    while (s > 21 && a > 0) { s -= 10; a--; }
    return s;
}

// Inizia partita (gestione logica di gioco e distribuzione iniziale)
function inizia(cod) {
    const t = tavoli.get(cod);
    if (!t) return;
    
    t.mazzo = mazzo();
    t.pc = [t.mazzo.pop(), t.mazzo.pop()]; // Giocatore
    t.dc = [t.mazzo.pop(), t.mazzo.pop()]; // Banco
    
    // Invia lo stato iniziale al client
    t.plr.send('DEALER_RESET');
    t.plr.send('CARDS ' + t.pc.join(','));
    t.plr.send('DEALER_INIT ' + t.dc[0] + ' ' + t.dc[1]); // Prima carta nascosta, seconda visibile
    t.plr.send('YOUR_TURN');
}

// Turno del Banco
function turnoDealer(cod) {
    const t = tavoli.get(cod);
    if (!t) return;
    
    // Rimuove la carta nascosta
    t.plr.send('DEALER_REVEAL');
    
    setTimeout(() => {
        // Dealer pesca fino a 17
        const drawInterval = setInterval(() => {
            if (punteggio(t.dc) < 17) {
                t.dc.push(t.mazzo.pop());
                t.plr.send('DEALER_CARD ' + t.dc[t.dc.length - 1]);
            } else {
                clearInterval(drawInterval);
                calcolaRisultato(cod);
            }
        }, 500); // Ritmo di pesca del dealer
    }, 1000);
}

// Calcola il vincitore e invia il risultato
function calcolaRisultato(cod) {
    const t = tavoli.get(cod);
    if (!t) return;
    
    const pp = punteggio(t.pc);
    const dp = punteggio(t.dc);
    let ris = 'PUSH';
    
    if (pp > 21) ris = 'LOSE';
    else if (dp > 21) ris = 'WIN';
    else if (pp > dp) ris = 'WIN';
    else if (pp < dp) ris = 'LOSE';
    
    t.plr.send('RESULT ' + ris);
    setTimeout(() => t.plr.send('PLAY_AGAIN?'), 1000);
}

// Gestione connessioni WebSocket
wss.on('connection', ws => {
    let cod = null;
    console.log('Nuovo client connesso');

    ws.on('message', msg => {
        const m = msg.toString();
        console.log('Ricevuto:', m);

        // CREAZIONE E JOIN
        if (m === 'CREATE') {
            cod = codice();
            tavoli.set(cod, { plr: ws, mazzo: mazzo(), pc: [], dc: [] });
            ws.send('TABLE_CREATED ' + cod);
        }
        else if (m.startsWith('JOIN')) {
            cod = m.split(' ')[1];
            const t = tavoli.get(cod);
            if (!t) ws.send('TABLE_NOT_FOUND');
            else if (t.plr !== ws && t.plr) ws.send('TABLE_FULL');
            else {
                t.plr = ws;
                ws.send('TABLE_JOINED ' + cod);
                inizia(cod);
            }
        }
        
        // COMANDI DI GIOCO
        else if (m === 'HIT') {
            const t = tavoli.get(cod);
            if (!t) return;
            t.pc.push(t.mazzo.pop());
            ws.send('CARDS ' + t.pc.join(','));
            if (punteggio(t.pc) >= 21) turnoDealer(cod);
        }
        else if (m === 'STAND') {
            turnoDealer(cod);
        }
        else if (m === 'YES') {
            inizia(cod);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnesso');
        // Rimuove il tavolo se il giocatore è l'unico connesso (oppure logica più complessa per N giocatori)
        if (cod) tavoli.delete(cod); 
    });
});

// Avvia server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server attivo su porta ${PORT}`);
    console.log(`HTTP: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
});