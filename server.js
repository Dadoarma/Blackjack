// SERVER BLACKJACK SEMPLIFICATO
const WebSocket = require('ws');
const server = new WebSocket.Server({ port: 8080 });

// Tavoli attivi
const tavoli = new Map();

// Mazzo di carte
const CARTE = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SEMI = ['♠', '♥', '♦', '♣'];

// Genera mazzo
function mazzo() {
    const m = [];
    for (let s of SEMI) for (let c of CARTE) m.push(c + s);
    return m.sort(() => Math.random() - 0.5);
}

// Genera codice tavolo
function codice() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Calcola punteggio
function punteggio(carte) {
    let s = 0, a = 0;
    for (let c of carte) {
        const v = c.slice(0, -1);
        if (v === 'A') { s += 11; a++; }
        else s += ['J', 'Q', 'K'].includes(v) ? 10 : +v;
    }
    while (s > 21 && a > 0) { s -= 10; a--; }
    return s;
}

// Gestione connessioni
server.on('connection', ws => {
    let cod = null;

    ws.on('message', msg => {
        const m = msg.toString();

        // Crea tavolo
        if (m === 'CREATE') {
            cod = codice();
            tavoli.set(cod, { plr: ws, mazzo: mazzo(), pc: [], dc: [] });
            ws.send('TABLE_CREATED ' + cod);
        }
        
        // Unisciti
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
        
        // Carta
        else if (m === 'HIT') {
            const t = tavoli.get(cod);
            if (!t) return;
            t.pc.push(t.mazzo.pop());
            ws.send('CARDS ' + t.pc.join(','));
            if (punteggio(t.pc) >= 21) turnoDealer(cod);
        }
        
        // Stai
        else if (m === 'STAND') {
            turnoDealer(cod);
        }
        
        // Ancora
        else if (m === 'YES') {
            inizia(cod);
        }
    });

    ws.on('close', () => {
        if (cod) tavoli.delete(cod);
    });
});

// Inizia partita
function inizia(cod) {
    const t = tavoli.get(cod);
    if (!t) return;
    
    t.mazzo = mazzo();
    t.pc = [t.mazzo.pop(), t.mazzo.pop()];
    t.dc = [t.mazzo.pop(), t.mazzo.pop()];
    
    t.plr.send('DEALER_RESET');
    t.plr.send('CARDS ' + t.pc.join(','));
    t.plr.send('DEALER_INIT ' + t.dc[0] + ' ' + t.dc[1]);
    t.plr.send('YOUR_TURN');
}

// Turno dealer
function turnoDealer(cod) {
    const t = tavoli.get(cod);
    if (!t) return;
    
    t.plr.send('DEALER_REVEAL');
    
    setTimeout(() => {
        // Dealer pesca fino a 17
        while (punteggio(t.dc) < 17) {
            t.dc.push(t.mazzo.pop());
            t.plr.send('DEALER_CARD ' + t.dc[t.dc.length - 1]);
        }
        
        setTimeout(() => {
            const pp = punteggio(t.pc);
            const dp = punteggio(t.dc);
            let ris = 'PUSH';
            
            if (pp > 21) ris = 'LOSE';
            else if (dp > 21) ris = 'WIN';
            else if (pp > dp) ris = 'WIN';
            else if (pp < dp) ris = 'LOSE';
            
            t.plr.send('RESULT ' + ris);
            setTimeout(() => t.plr.send('PLAY_AGAIN?'), 1000);
        }, 1000);
    }, 1000);
}

console.log('Server attivo su porta 8080');