// Importa il framework Express, che semplifica la creazione di server web
const express = require("express");
// Importa il modulo HTTP necessario per creare server HTTP
const http = require("http");
// Importa la libreria 'ws' per gestire WebSocket
const WebSocket = require("ws");
// Importa il modulo 'path' di Node.js per gestire i percorsi dei file
const path = require("path");

const app = express();
// Creo il server HTTP utilizzando l'app Express
const server = http.createServer(app);

// Tutti i file presenti nella directory dello script saranno accessibili direttamente via URL es. localhost:8000/server.js
app.use(express.static(__dirname));
// Rimanda al file "client.html" presente nella cartella corrente
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "client.html")));

// Creo un server WebSocket associato al server HTTP, in modo tale che i client condividono la stessa porta
const wss = new WebSocket.Server({ server });

const PORT = 8000;
const MAX_PLAYERS_PER_TABLE = 5;

// Salvo i semi e i valori delle carte in costanti
const SUITS = ["♥", "♦", "♣", "♠"];
const CARD_VALUES = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

// Definisco un oggetto per tenere traccia dei tavoli di gioco attivi (salvando i codici univoci)
const tables = {};

// Funzione per impostare dei timer di attesa nel server
function wait(ms) {
    return new Promise(function(resolve) {
        setTimeout(resolve, ms);
    });
}

// Funzione per creare un mazzo di carte mischiato
function createDeck() {
    const deck = [];
    for (let suit of SUITS)
        for (let valueIndex = 0; valueIndex < 13; valueIndex++)
            deck.push({ valueIndex, suit });
    // Mischia il mazzo prima di restituirlo
    return shuffle(deck);
}

// Funzione per mischiare un array (Fisher-Yates Shuffle)
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Funzione che emette la carta come stringa (es. "A♥", "10♠", "K♦")
function formatCard(card) {
    return CARD_VALUES[card.valueIndex] + card.suit;
}

// Funzione per generare un codice univoco per ogni tavolo
function generateTableCode() {
    let code;
    // toString(36) converte il numero in base 36 (numeri + lettere), slice(2, 8) prende 6 caratteri (2-6, escludendo "0.")
    do code = Math.random().toString(36).slice(2, 8).toUpperCase();
    while (tables[code]);
    return code;
}

// Funzione per calcolare il valore di una mano
function getHandValue(hand) {
    let total = 0, acesCount = 0;
    for (let card of hand) {
        let value;

        if (card.valueIndex === 0){
            // L'Asso vale 11 inizialmente
            value = 11;
            acesCount++;
        } else if (card.valueIndex >= 10) {
            // Re, Regina, Fante valgono 10
            value = 10;
        } else {
            // Tutte le altre carte valgono il loro indice + 1
            value = card.valueIndex + 1;
        }

        total += value;
    }

    // Gestione del valore dell'Asso (11 o 1)
    while (total > 21 && acesCount > 0) {
        total -= 10; // riduce 11 a 1 per un Asso
        acesCount--; // decrementa il numero di assi da considerare
    }

    return total;
}

// Funzione per inviare un messaggio a un client
function sendMessage(ws, message) {
    // Controlla che il destinatario esista e che la connessione WebSocket sia aperta
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
        console.log("Messaggio inviato:", message);
    } else {
        console.log("Impossibile inviare il messaggio: connessione chiusa o inesistente");
    }
}

// Funzione per inviare un messaggio a tutti i giocatori di un tavolo
function broadcastMessage(table, message) {
    for (let player of table.players) {
        sendMessage(player, message);
    }
}

// Funzione per controllare periodicamente se il giocatore ha risposto, altrimenti restituisce "STAND" dopo 30 secondi
function waitForPlayerResponse(ws) {
    return new Promise(resolve => {
        // In caso di connessione già chiusa, risponde con "STAND"
        if (!ws || ws.readyState !== WebSocket.OPEN) return resolve("STAND");
        
        let elapsedTime = 0;
        const interval = setInterval(() => {
            // In caso di disconnessione durante l'attesa, risponde con "STAND"
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                clearInterval(interval); // Fermo l'esecuzione del timer ogni 200ms
                resolve("STAND");
            } else if (ws.queue.length > 0) { // Se il giocatore ha risposto, restituisce la risposta
                clearInterval(interval);
                resolve(ws.queue.shift()); // Restituisco la prima risposta in coda (potrebbero essercene più di una)
            } else if (elapsedTime > 30000) { // Timeout di 30 secondi
                clearInterval(interval);
                resolve("STAND");
            }
            elapsedTime += 200;
        }, 200);
    });
}

// Funzione per unire un giocatore a un tavolo
function joinTable(ws, tableCode) {
    const table = tables[tableCode]; // Ottengo il tavolo corrispondente al codice
    ws.tableCode = tableCode; // Associo il codice del tavolo al giocatore
    ws.queue = []; // Inizializzo la coda dei messaggi del giocatore

    // Aggiungo il giocatore alla lista dei giocatori attivi o in attesa, a seconda dello stato del tavolo
    if (!table.isRunning) {
        table.players.push(ws);
        table.hands.push([]);
    } else {
        table.pendingPlayers.push(ws);
        table.pendingHands.push([]);
    }

    sendMessage(ws, `TABLE_JOINED ${tableCode}`);

    if (!table.isRunning && table.players.length === 1) {
        table.isRunning = true;
        runGameLoop(tableCode);
    }
}

// Funzione principale del ciclo di gioco
async function runGameLoop(tableCode) {
    const table = tables[tableCode];
    if (!table) return;

    table.deck = createDeck();
    table.hands = table.players.map(() => []); // Inizializzo le mani dei giocatori
    broadcastMessage(table, "DEALER_RESET");

    // Prendo le prime due carte per il dealer dal mazzo
    table.dealer = [table.deck.shift(), table.deck.shift()];
    broadcastMessage(table, `DEALER_INIT ${formatCard(table.dealer[0])},${formatCard(table.dealer[1])}`);
    await wait(600);

    // Distribuisco le carte ai giocatori
    for (let i = 0; i < table.players.length; i++) {
        const player = table.players[i];

        // Assegna le due carte seguenti del mazzo al giocatore
        table.hands[i] = [];
        table.hands[i].push(table.deck.shift());
        table.hands[i].push(table.deck.shift());

        const cardsMessage = "CARDS " + table.hands[i].map(formatCard).join(",");
        sendMessage(player, cardsMessage);
    }
    await wait(400);

    // Gestione dei giocatori, uno per volta
    for (let i = 0; i < table.players.length; i++) {
        const player = table.players[i];
        if (!player || player.readyState !== WebSocket.OPEN) continue;

        while (getHandValue(table.hands[i]) < 21) {
            sendMessage(player, "YOUR_TURN");
            const response = await waitForPlayerResponse(player);

            if (response === "HIT") {
                table.hands[i].push(table.deck.shift());
                sendMessage(player, "CARDS " + table.hands[i].map(formatCard).join(","));
                if (getHandValue(table.hands[i]) > 21) break;
            } else break;
        }
    }

    // Chiusura da parte del dealer
    let hasActivePlayer = false;

    for (const hand of table.hands) {
        const value = getHandValue(hand);
        if (value <= 21) { // Se un giocatore non busta
            hasActivePlayer = true;
            break;
        }
    }

    broadcastMessage(table, "DEALER_REVEAL");
    await wait(800);

    while (hasActivePlayer && getHandValue(table.dealer) < 17) {
        const card = table.deck.shift();
        table.dealer.push(card);
        broadcastMessage(table, "DEALER_CARD " + formatCard(card));
        await wait(500);
    }

    // Manda i risultati ai giocatori
    const dealerValue = getHandValue(table.dealer);
    for (let i = 0; i < table.players.length; i++) {
        const player = table.players[i];
        const playerValue = getHandValue(table.hands[i]);
        let result;

        if (playerValue > 21) {
            result = "LOSE";
        } else if (dealerValue > 21) {
            result = "WIN";
        } else if (playerValue > dealerValue) {
            result = "WIN";
        } else if (playerValue === dealerValue) {
            result = "PUSH";
        } else {
            result = "LOSE";
        }
        sendMessage(player, `RESULT ${result} DEALER ${table.dealer.map(formatCard).join(",")}`);
    }
    await wait(600);

    // Ricomincia il ciclo di gioco se ci sono ancora giocatori attivi
    const remainingPlayers = [];
    // Itero sui giocatori attivi per chiedere se vogliono giocare di nuovo
    for (let player of table.players.slice()) { // Uso slice() per creare una copia dell'array originale
        if (!player || player.readyState !== WebSocket.OPEN) continue;
        broadcastMessage(table, "PLAY_AGAIN_LOCK");
        sendMessage(player, "PLAY_AGAIN?");

        const response = await waitForPlayerResponse(player);
        if (response === "YES") remainingPlayers.push(player);
        await wait(200);
    }

    // Aggiungi giocatori in attesa di giocare
    for (let i = 0; i < table.pendingPlayers.length; i++) {
        const player = table.pendingPlayers[i];

        if (player.readyState === WebSocket.OPEN) {
            remainingPlayers.push(player);
        }
    }

    // Resetta lo stato del tavolo per il prossimo ciclo di gioco
    table.pendingPlayers = [];
    table.pendingHands = [];
    table.players = remainingPlayers;

    if (table.players.length) {
        await wait(1500);
        runGameLoop(tableCode);
    } else {
        delete tables[tableCode];
    }
}

wss.on("connection", ws => {
    ws.queue = [];
    // Gestione messaggi ricevuti dal client
    ws.on("message", rawMessage => {
        const message = rawMessage.toString().trim(); // Converto il messaggio in stringa e rimuovo spazi
        const [command, data] = message.split(" ", 2); // Divido il messaggio in comando e dati

        if (command === "CREATE") {
            const code = generateTableCode();
            // Struttura del tavolo
            tables[code] = {
                players: [], hands: [],
                pendingPlayers: [], pendingHands: [],
                deck: [], dealer: [], isRunning: false
            };
            joinTable(ws, code); // Unisce il giocatore al tavolo appena creato
            sendMessage(ws, `TABLE_CREATED ${code}`);
        } else if (command === "JOIN") {
            if (!tables[data]) return sendMessage(ws, "TABLE_NOT_FOUND"); // Controlla se il tavolo esiste (data = codice)
            const table = tables[data];
            if (table.players.length + table.pendingPlayers.length >= MAX_PLAYERS_PER_TABLE)
                return sendMessage(ws, "TABLE_FULL");
            joinTable(ws, data); // Unisce il giocatore al tavolo
        } else {
            ws.queue.push(command);
        }
    });
    // Gestione della disconnessione del client
    ws.on("close", () => {
        const code = ws.tableCode;
        if (!code || !tables[code]) return;
        const table = tables[code];

        function removePlayer(arr) {
            var index = arr.indexOf(ws); // Restituisce -1 se non trovato
            if (index !== -1) {
                arr.splice(index, 1); // Rimuove il giocatore dall'array
            }
        }

        removePlayer(table.players);
        removePlayer(table.pendingPlayers);

        if (table.players.length === 0 && table.pendingPlayers.length === 0)
            delete tables[code];
    });
});

// Quando avvio il server, stampo un messaggio di conferma
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));