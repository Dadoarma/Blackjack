const express = require('express');
const http = require('http');
const WebSocket = require('ws');
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
const CARDS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♥', '♦', '♣', '♠'];
const PORT = process.env.PORT || 8080;

class Table {
    constructor(code) {
        this.code = code;
        this.players = new Map(); // id -> {ws, name, hand, status, chips}
        this.dealerHand = [];
        this.deck = [];
        this.gameState = 'waiting'; // waiting, playing, results
        this.currentPlayerIndex = 0;
        this.pendingActions = new Map();
    }
    
    addPlayer(ws, name) {
        const id = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.players.set(id, {
            ws,
            name,
            hand: [],
            status: 'waiting',
            chips: 1000,
            bet: 0
        });
        return id;
    }
    
    removePlayer(id) {
        return this.players.delete(id);
    }
    
    broadcast(message, excludeId = null) {
        this.players.forEach((player, id) => {
            if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(message);
            }
        });
    }
    
    sendPlayerList() {
        const playerList = {};
        this.players.forEach((player, id) => {
            playerList[id] = {
                name: player.name,
                status: player.status,
                chips: player.chips
            };
        });
        this.broadcast(`PLAYER_LIST ${JSON.stringify(playerList)}`);
    }
    
    initializeDeck() {
        this.deck = [];
        for (const suit of SUITS) {
            for (let i = 0; i < CARDS.length; i++) {
                this.deck.push({ value: CARDS[i], suit, numericValue: this.getCardValue(CARDS[i]) });
            }
        }
        this.shuffleDeck();
    }
    
    shuffleDeck() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }
    
    getCardValue(card) {
        if (card === 'A') return 11;
        if (['J', 'Q', 'K'].includes(card)) return 10;
        return parseInt(card);
    }
    
    calculateHandValue(hand) {
        let value = 0;
        let aces = 0;
        
        hand.forEach(card => {
            value += card.numericValue;
            if (card.value === 'A') aces++;
        });
        
        while (value > 21 && aces > 0) {
            value -= 10;
            aces--;
        }
        
        return value;
    }
    
    formatCard(card) {
        return `${card.value}${card.suit}`;
    }
    
    drawCard() {
        if (this.deck.length === 0) {
            this.initializeDeck();
        }
        return this.deck.pop();
    }
}

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (tables[code]);
    return code;
}

async function playRound(table) {
    table.gameState = 'playing';
    table.initializeDeck();
    table.dealerHand = [];
    
    // Reset player hands and status
    table.players.forEach(player => {
        player.hand = [];
        player.status = 'playing';
    });
    
    // Send reset to all players
    table.broadcast('DEALER_RESET');
    await wait(500);
    
    // Deal initial cards
    table.players.forEach(player => {
        player.hand.push(table.drawCard());
        player.hand.push(table.drawCard());
        const cardsStr = player.hand.map(c => table.formatCard(c)).join(',');
        player.ws.send(`CARDS ${cardsStr}`);
    });
    
    // Deal dealer cards
    table.dealerHand.push(table.drawCard());
    table.dealerHand.push(table.drawCard());
    
    const dealerInitStr = `${table.formatCard(table.dealerHand[0])} ${table.formatCard(table.dealerHand[1])}`;
    table.broadcast(`DEALER_INIT ${dealerInitStr}`);
    await wait(800);
    
    table.sendPlayerList();
    
    // Player turns
    const playerIds = Array.from(table.players.keys());
    
    for (const playerId of playerIds) {
        const player = table.players.get(playerId);
        if (!player || player.ws.readyState !== WebSocket.OPEN) continue;
        
        player.status = 'playing';
        table.sendPlayerList();
        
        // Check for blackjack
        if (table.calculateHandValue(player.hand) === 21) {
            player.status = 'blackjack';
            table.sendPlayerList();
            continue;
        }
        
        // Player's turn
        player.ws.send('YOUR_TURN');
        table.broadcast(`PLAYER_ACTION ${playerId}:PLAYING`);
        
        let bust = false;
        while (table.calculateHandValue(player.hand) < 21) {
            const action = await waitForAction(player.ws, playerId);
            
            if (action === 'HIT') {
                const newCard = table.drawCard();
                player.hand.push(newCard);
                player.ws.send(`CARDS ${player.hand.map(c => table.formatCard(c)).join(',')}`);
                
                if (table.calculateHandValue(player.hand) > 21) {
                    player.status = 'bust';
                    bust = true;
                    table.broadcast(`PLAYER_ACTION ${playerId}:BUST`);
                    break;
                }
            } else if (action === 'STAND') {
                player.status = 'stand';
                table.broadcast(`PLAYER_ACTION ${playerId}:STAND`);
                break;
            }
        }
        
        if (!bust && player.status !== 'stand') {
            player.status = 'stand';
        }
        
        table.sendPlayerList();
        await wait(1000);
    }
    
    // Dealer's turn
    table.broadcast('DEALER_REVEAL');
    await wait(1000);
    
    // Check if any player is still in the game
    const anyPlayerAlive = Array.from(table.players.values())
        .some(p => p.status !== 'bust' && p.status !== 'blackjack');
    
    if (anyPlayerAlive) {
        while (table.calculateHandValue(table.dealerHand) < 17) {
            await wait(800);
            const newCard = table.drawCard();
            table.dealerHand.push(newCard);
            table.broadcast(`DEALER_CARD ${table.formatCard(newCard)}`);
        }
    }
    
    // Calculate results
    const dealerValue = table.calculateHandValue(table.dealerHand);
    const dealerCardsStr = table.dealerHand.map(c => table.formatCard(c)).join(',');
    
    table.players.forEach((player, id) => {
        if (player.ws.readyState !== WebSocket.OPEN) return;
        
        const playerValue = table.calculateHandValue(player.hand);
        let result = '';
        
        if (player.status === 'bust') {
            result = 'LOSE';
        } else if (player.status === 'blackjack' && dealerValue !== 21) {
            result = 'WIN';
        } else if (dealerValue > 21) {
            result = 'WIN';
        } else if (playerValue > dealerValue) {
            result = 'WIN';
        } else if (playerValue === dealerValue) {
            result = 'PUSH';
        } else {
            result = 'LOSE';
        }
        
        // Update chips
        if (result === 'WIN') {
            player.chips += player.bet * (player.status === 'blackjack' ? 2.5 : 2);
        } else if (result === 'PUSH') {
            player.chips += player.bet;
        }
        
        player.ws.send(`RESULT ${result} DEALER ${dealerCardsStr}`);
    });
    
    table.gameState = 'results';
    table.sendPlayerList();
    await wait(2000);
    
    // Ask players if they want to play again
    const replayPromises = [];
    table.players.forEach((player, id) => {
        if (player.ws.readyState !== WebSocket.OPEN) return;
        
        player.ws.send('PLAY_AGAIN?');
        replayPromises.push(waitForAction(player.ws, id, 30000));
    });
    
    // Wait for all responses
    const responses = await Promise.all(replayPromises);
    
    // Remove players who said NO or didn't respond
    const playersToRemove = [];
    table.players.forEach((player, id) => {
        const index = Array.from(table.players.keys()).indexOf(id);
        if (responses[index] !== 'YES') {
            playersToRemove.push(id);
        }
    });
    
    playersToRemove.forEach(id => {
        table.players.get(id)?.ws?.close();
        table.players.delete(id);
    });
    
    if (table.players.size > 0) {
        table.broadcast('PLAY_AGAIN_LOCK');
        await wait(1000);
        playRound(table);
    } else {
        delete tables[table.code];
        console.log(`🗑️ Table ${table.code} deleted (no players left)`);
    }
}

function waitForAction(ws, playerId, timeout = 30000) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve('STAND'); // Default to STAND on timeout
        }, timeout);
        
        const onMessage = (message) => {
            const msg = message.toString().trim();
            if (['HIT', 'STAND', 'YES', 'NO'].includes(msg)) {
                cleanup();
                resolve(msg);
            }
        };
        
        const cleanup = () => {
            clearTimeout(timer);
            ws.removeListener('message', onMessage);
        };
        
        ws.on('message', onMessage);
    });
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('🔗 New connection');
    
    ws.on('message', (message) => {
        const msg = message.toString().trim();
        const [command, ...args] = msg.split(' ');
        const arg = args.join(' ');
        
        console.log('📩 Received:', command, arg);
        
        if (command === 'CREATE') {
            const playerName = arg || 'Player';
            const code = generateCode();
            const table = new Table(code);
            tables[code] = table;
            
            const playerId = table.addPlayer(ws, playerName);
            ws.playerId = playerId;
            ws.tableCode = code;
            
            ws.send(`TABLE_CREATED ${code}`);
            ws.send(`YOUR_ID ${playerId}`);
            table.sendPlayerList();
            
            console.log(`✅ Table ${code} created by ${playerName}`);
            
            // Start game if there are players
            setTimeout(() => {
                if (table.players.size > 0) {
                    playRound(table);
                }
            }, 2000);
            
        } else if (command === 'JOIN') {
            const [code, playerName] = arg.split(' ');
            const table = tables[code];
            
            if (!table) {
                ws.send('TABLE_NOT_FOUND');
                return;
            }
            
            if (table.players.size >= MAX_PLAYERS) {
                ws.send('TABLE_FULL');
                return;
            }
            
            if (table.gameState !== 'waiting') {
                ws.send('GAME_IN_PROGRESS');
                return;
            }
            
            const playerId = table.addPlayer(ws, playerName || 'Player');
            ws.playerId = playerId;
            ws.tableCode = code;
            
            ws.send(`TABLE_JOINED ${code}`);
            ws.send(`YOUR_ID ${playerId}`);
            table.sendPlayerList();
            
            console.log(`✅ ${playerName} joined table ${code}`);
            
        } else if (command === 'HIT' || command === 'STAND' || command === 'YES' || command === 'NO') {
            // These are handled by the waitForAction function
            // The message will be caught by the event listener set up there
        }
    });
    
    ws.on('close', () => {
        console.log('🔒 Connection closed');
        
        if (ws.tableCode && tables[ws.tableCode]) {
            const table = tables[ws.tableCode];
            if (table.players.has(ws.playerId)) {
                table.players.delete(ws.playerId);
                table.sendPlayerList();
                console.log(`❌ Player left table ${ws.tableCode}`);
                
                // If no players left, clean up table
                if (table.players.size === 0) {
                    delete tables[ws.tableCode];
                    console.log(`🗑️ Table ${ws.tableCode} deleted (no players left)`);
                }
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
});

server.listen(PORT, () => {
    console.log(`🎰 Blackjack Server running on port ${PORT}`);
    console.log(`🌐 HTTP: http://localhost:${PORT}`);
    console.log(`💬 WebSocket: ws://localhost:${PORT}`);
    console.log('\nCommands:');
    console.log('  CREATE [name] - Create a new table');
    console.log('  JOIN [code] [name] - Join an existing table');
    console.log(`  Max ${MAX_PLAYERS} players per table\n`);
});