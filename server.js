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

class Player {
    constructor(ws, name) {
        this.ws = ws;
        this.name = name;
        this.id = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.hand = [];
        this.status = 'waiting';
        this.chips = 1000;
        this.bet = 100;
        this.hasActed = false;
    }
}

class Table {
    constructor(code) {
        this.code = code;
        this.players = new Map();
        this.dealerHand = [];
        this.deck = [];
        this.gameState = 'waiting'; // waiting, playing, results
        this.currentPlayerIndex = -1;
        this.initializeDeck();
    }
    
    initializeDeck() {
        this.deck = [];
        for (const suit of SUITS) {
            for (const value of CARDS) {
                this.deck.push({ value, suit });
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
    
    addPlayer(ws, name) {
        if (this.players.size >= MAX_PLAYERS) {
            return { success: false, reason: 'Table is full' };
        }
        
        const player = new Player(ws, name);
        this.players.set(player.id, player);
        return { success: true, player };
    }
    
    removePlayer(playerId) {
        const player = this.players.get(playerId);
        if (player) {
            this.players.delete(playerId);
            this.broadcastPlayerList();
            return true;
        }
        return false;
    }
    
    broadcast(message, excludePlayerId = null) {
        this.players.forEach((player, id) => {
            if (id !== excludePlayerId && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(message);
            }
        });
    }
    
    sendToPlayer(playerId, message) {
        const player = this.players.get(playerId);
        if (player && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(message);
        }
    }
    
    broadcastPlayerList() {
        const playerList = {};
        this.players.forEach((player, id) => {
            playerList[id] = {
                name: player.name,
                status: player.status,
                chips: player.chips,
                bet: player.bet
            };
        });
        
        const message = `PLAYER_LIST ${JSON.stringify(playerList)}`;
        this.broadcast(message);
    }
    
    formatCard(card) {
        return `${card.value}${card.suit}`;
    }
    
    calculateHandValue(hand) {
        let value = 0;
        let aces = 0;
        
        for (const card of hand) {
            if (card.value === 'A') {
                value += 11;
                aces++;
            } else if (['J', 'Q', 'K'].includes(card.value)) {
                value += 10;
            } else if (card.value === '10') {
                value += 10;
            } else {
                value += parseInt(card.value);
            }
        }
        
        while (value > 21 && aces > 0) {
            value -= 10;
            aces--;
        }
        
        return value;
    }
    
    drawCard() {
        if (this.deck.length < 10) {
            this.initializeDeck();
        }
        return this.deck.pop();
    }
    
    async startGame() {
        if (this.players.size === 0) return;
        
        this.gameState = 'playing';
        this.dealerHand = [];
        
        // Reset player states
        this.players.forEach(player => {
            player.hand = [];
            player.status = 'playing';
            player.hasActed = false;
        });
        
        // Reset deck if needed
        if (this.deck.length < 20) {
            this.initializeDeck();
        }
        
        // Broadcast game start
        this.broadcast('GAME_START');
        this.broadcast('DEALER_RESET');
        
        await this.sleep(500);
        
        // Deal initial cards
        this.players.forEach(player => {
            player.hand.push(this.drawCard());
            player.hand.push(this.drawCard());
            
            const cardsStr = player.hand.map(card => this.formatCard(card)).join(',');
            this.sendToPlayer(player.id, `CARDS ${cardsStr}`);
            
            // Check for blackjack
            if (this.calculateHandValue(player.hand) === 21) {
                player.status = 'blackjack';
                this.broadcast(`PLAYER_ACTION ${player.id}:BLACKJACK`);
            }
        });
        
        // Deal dealer cards
        this.dealerHand.push(this.drawCard());
        this.dealerHand.push(this.drawCard());
        
        const dealerInitStr = `${this.formatCard(this.dealerHand[0])} ${this.formatCard(this.dealerHand[1])}`;
        this.broadcast(`DEALER_INIT ${dealerInitStr}`);
        
        this.broadcastPlayerList();
        await this.sleep(1000);
        
        // Start player turns
        await this.playPlayerTurns();
    }
    
    async playPlayerTurns() {
        const playerIds = Array.from(this.players.keys());
        
        for (let i = 0; i < playerIds.length; i++) {
            const playerId = playerIds[i];
            const player = this.players.get(playerId);
            
            if (!player || player.status === 'blackjack' || player.status === 'bust') {
                continue;
            }
            
            this.currentPlayerIndex = i;
            player.status = 'playing';
            this.broadcastPlayerList();
            this.broadcast(`PLAYER_ACTION ${playerId}:PLAYING`);
            
            // Send turn to player
            this.sendToPlayer(playerId, 'YOUR_TURN');
            
            // Wait for player action
            const action = await this.waitForPlayerAction(player);
            
            if (action === 'HIT') {
                player.hand.push(this.drawCard());
                const cardsStr = player.hand.map(card => this.formatCard(card)).join(',');
                this.sendToPlayer(playerId, `CARDS ${cardsStr}`);
                
                if (this.calculateHandValue(player.hand) > 21) {
                    player.status = 'bust';
                    this.broadcast(`PLAYER_ACTION ${playerId}:BUST`);
                }
            } else if (action === 'STAND') {
                player.status = 'standing';
                this.broadcast(`PLAYER_ACTION ${playerId}:STAND`);
            } else if (action === 'DOUBLE') {
                if (player.chips >= player.bet * 2) {
                    player.bet *= 2;
                    player.hand.push(this.drawCard());
                    const cardsStr = player.hand.map(card => this.formatCard(card)).join(',');
                    this.sendToPlayer(playerId, `CARDS ${cardsStr}`);
                    
                    if (this.calculateHandValue(player.hand) > 21) {
                        player.status = 'bust';
                        this.broadcast(`PLAYER_ACTION ${playerId}:BUST`);
                    } else {
                        player.status = 'standing';
                        this.broadcast(`PLAYER_ACTION ${playerId}:DOUBLE`);
                    }
                }
            }
            
            player.hasActed = true;
            this.broadcastPlayerList();
            await this.sleep(1000);
        }
        
        // All players have acted, dealer's turn
        await this.playDealerTurn();
    }
    
    async waitForPlayerAction(player) {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                cleanup();
                resolve('STAND');
            }, 30000);
            
            const onMessage = (message) => {
                const msg = message.toString().trim();
                if (['HIT', 'STAND', 'DOUBLE'].includes(msg)) {
                    cleanup();
                    resolve(msg);
                }
            };
            
            const cleanup = () => {
                clearTimeout(timeout);
                player.ws.removeListener('message', onMessage);
            };
            
            player.ws.on('message', onMessage);
        });
    }
    
    async playDealerTurn() {
        this.broadcast('DEALER_REVEAL');
        await this.sleep(1000);
        
        // Check if any player is still in the game
        const anyPlayerAlive = Array.from(this.players.values())
            .some(p => p.status !== 'bust' && p.status !== 'blackjack');
        
        if (anyPlayerAlive) {
            while (this.calculateHandValue(this.dealerHand) < 17) {
                await this.sleep(800);
                const newCard = this.drawCard();
                this.dealerHand.push(newCard);
                this.broadcast(`DEALER_CARD ${this.formatCard(newCard)}`);
            }
        }
        
        // Calculate and send results
        await this.calculateResults();
    }
    
    async calculateResults() {
        const dealerValue = this.calculateHandValue(this.dealerHand);
        const dealerCardsStr = this.dealerHand.map(card => this.formatCard(card)).join(',');
        
        this.players.forEach((player, playerId) => {
            if (player.ws.readyState !== WebSocket.OPEN) return;
            
            const playerValue = this.calculateHandValue(player.hand);
            let result = '';
            
            if (player.status === 'bust') {
                result = 'LOSE';
                player.chips -= player.bet;
            } else if (player.status === 'blackjack') {
                if (dealerValue === 21 && this.dealerHand.length === 2) {
                    result = 'PUSH';
                } else {
                    result = 'BLACKJACK';
                    player.chips += Math.floor(player.bet * 2.5);
                }
            } else if (dealerValue > 21) {
                result = 'WIN';
                player.chips += player.bet * 2;
            } else if (playerValue > dealerValue) {
                result = 'WIN';
                player.chips += player.bet * 2;
            } else if (playerValue === dealerValue) {
                result = 'PUSH';
                // Return bet
                player.chips += player.bet;
            } else {
                result = 'LOSE';
                player.chips -= player.bet;
            }
            
            // Send result
            this.sendToPlayer(playerId, `RESULT ${result} DEALER ${dealerCardsStr}`);
            this.sendToPlayer(playerId, `CHIP_UPDATE ${player.chips}`);
        });
        
        this.gameState = 'results';
        this.broadcastPlayerList();
        await this.sleep(2000);
        
        // Ask players if they want to play again
        await this.askPlayAgain();
    }
    
    async askPlayAgain() {
        const playerIds = Array.from(this.players.keys());
        const responses = new Map();
        
        // Ask each player
        for (const playerId of playerIds) {
            const player = this.players.get(playerId);
            if (player && player.ws.readyState === WebSocket.OPEN) {
                this.sendToPlayer(playerId, 'PLAY_AGAIN?');
                responses.set(playerId, false);
            }
        }
        
        // Set timeout for responses
        await this.sleep(30000);
        
        // Remove players who didn't respond
        const playersToRemove = [];
        this.players.forEach((player, playerId) => {
            if (!responses.get(playerId)) {
                playersToRemove.push(playerId);
            }
        });
        
        playersToRemove.forEach(playerId => {
            const player = this.players.get(playerId);
            if (player) {
                player.ws.close();
                this.players.delete(playerId);
            }
        });
        
        // Lock play again button
        this.broadcast('PLAY_AGAIN_LOCK');
        
        // If there are players left, start new game
        if (this.players.size > 0) {
            await this.sleep(2000);
            this.startGame();
        } else {
            delete tables[this.code];
            console.log(`Table ${this.code} deleted (no players left)`);
        }
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('🔗 New connection');
    
    ws.on('message', (message) => {
        const msg = message.toString().trim();
        const [command, ...args] = msg.split(' ');
        const arg = args.join(' ');
        
        console.log('📩 Received:', command, args);
        
        if (command === 'CREATE') {
            const playerName = arg || 'Player';
            const code = generateTableCode();
            const table = new Table(code);
            tables[code] = table;
            
            const result = table.addPlayer(ws, playerName);
            if (result.success) {
                ws.playerId = result.player.id;
                ws.tableCode = code;
                
                ws.send(`TABLE_CREATED ${code}`);
                ws.send(`YOUR_ID ${result.player.id}`);
                table.broadcastPlayerList();
                
                console.log(`✅ Table ${code} created by ${playerName}`);
                
                // Start game after short delay
                setTimeout(() => {
                    if (table.players.size > 0) {
                        table.startGame();
                    }
                }, 2000);
            }
            
        } else if (command === 'JOIN') {
            const [code, ...nameParts] = args;
            const playerName = nameParts.join(' ') || 'Player';
            
            if (!code || code.length !== 6) {
                ws.send('ERROR Invalid table code');
                return;
            }
            
            const table = tables[code];
            
            if (!table) {
                ws.send('TABLE_NOT_FOUND');
                return;
            }
            
            if (table.gameState !== 'waiting' && table.gameState !== 'results') {
                ws.send('GAME_IN_PROGRESS');
                return;
            }
            
            const result = table.addPlayer(ws, playerName);
            if (result.success) {
                ws.playerId = result.player.id;
                ws.tableCode = code;
                
                ws.send(`TABLE_JOINED ${code}`);
                ws.send(`YOUR_ID ${result.player.id}`);
                table.broadcastPlayerList();
                
                console.log(`✅ ${playerName} joined table ${code}`);
                
                // If game is waiting, start it
                if (table.gameState === 'waiting' && table.players.size > 0) {
                    setTimeout(() => {
                        table.startGame();
                    }, 2000);
                }
            } else {
                ws.send('TABLE_FULL');
            }
            
        } else if (['HIT', 'STAND', 'DOUBLE', 'YES', 'NO'].includes(command)) {
            // Game actions are handled by the table's waitForPlayerAction
            // This message will be caught by the event listener set up there
        }
    });
    
    ws.on('close', () => {
        console.log('🔒 Connection closed');
        
        if (ws.tableCode && tables[ws.tableCode]) {
            const table = tables[ws.tableCode];
            if (table.players.has(ws.playerId)) {
                table.players.delete(ws.playerId);
                table.broadcastPlayerList();
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

function generateTableCode() {
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

server.listen(PORT, () => {
    console.log(`🎰 Blackjack Premium Server running on port ${PORT}`);
    console.log(`🌐 HTTP: http://localhost:${PORT}`);
    console.log(`💬 WebSocket: ws://localhost:${PORT}`);
    console.log('\nReady for players!');
});