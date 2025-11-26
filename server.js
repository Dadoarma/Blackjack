const WebSocket = require("ws");

const port = process.env.PORT || 5000; // Render assegna la porta tramite env
const wss = new WebSocket.Server({ port });

console.log(`🎰 Server online on port ${port}\n`);

const tables = {};
const MAX = 5;

wss.on("connection", ws => {
    ws.q = [];
    ws.table = null;

    ws.on("message", m => {
        const msg = m.toString().trim();

        if (msg === "CREATE") {
            const code = genCode();
            tables[code] = { c: [], h: [], d: [], run: false };
            join(ws, code);
            ws.send(`TABLE_CREATED ${code}`);
            console.log(`✅ Table ${code} created`);
        } else if (msg.startsWith("JOIN ")) {
            const code = msg.split(" ")[1];
            if (!tables[code]) ws.send("TABLE_NOT_FOUND");
            else if (tables[code].c.length >= MAX) ws.send("TABLE_FULL");
            else {
                join(ws, code);
                ws.send(`TABLE_JOINED ${code}`);
                console.log(`✅ Joined ${code} (${tables[code].c.length}/${MAX})`);
            }
        } else {
            ws.q.push(msg.toUpperCase());
        }
    });

    ws.on("close", () => {
        if (ws.table) {
            const t = tables[ws.table];
            const i = t.c.indexOf(ws);
            if (i !== -1) {
                t.c.splice(i, 1);
                t.h.splice(i, 1);
                console.log(`❌ Player left ${ws.table}`);
                if (t.c.length === 0) {
                    delete tables[ws.table];
                    console.log(`🗑️  Deleted ${ws.table}`);
                }
            }
        }
    });
});

// ===== FUNZIONI DEL GIOCO =====

function genCode() {
    let c;
    do c = Array(6).fill().map(() => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.random() * 36 | 0]).join("");
    while (tables[c]);
    return c;
}

function join(ws, code) {
    ws.table = code;
    const t = tables[code];
    t.c.push(ws);
    t.h.push([]);
    if (!t.run && t.c.length > 0) {
        t.run = true;
        setTimeout(() => game(code), 1000);
    }
}

async function game(code) {
    const t = tables[code];
    if (!t) return;

    console.log(`\n🎮 [${code}] Game start`);

    // Init deck
    t.d = [];
    for (let s of ["♥", "♦", "♣", "♠"]) 
        for (let v = 1; v <= 13; v++) 
            t.d.push({ v, s });
    for (let i = t.d.length - 1; i > 0; i--) {
        const j = Math.random() * (i + 1) | 0;
        [t.d[i], t.d[j]] = [t.d[j], t.d[i]];
    }

    // Reset
    t.h = t.c.map(() => []);
    all(t, "DEALER_RESET");
    await wait(300);

    // Dealer
    const dealer = [draw(t), draw(t)];
    all(t, `DEALER_INIT ${fmt(dealer[0])} ${fmt(dealer[1])}`);
    await wait(800);

    // Players
    for (let i = 0; i < t.c.length; i++) {
        t.h[i] = [draw(t), draw(t)];
        send(t, i, `CARDS ${t.h[i].map(fmt).join(",")}`);
    }
    await wait(500);

    // Turns
    for (let i = 0; i < t.c.length; i++) {
        if (!t.c[i]) continue;
        console.log(`🎯 [${code}] P${i + 1} turn`);
        while (val(t.h[i]) < 21) {
            send(t, i, "YOUR_TURN");
            const r = await resp(t, i);
            if (r === "HIT") {
                t.h[i].push(draw(t));
                send(t, i, `CARDS ${t.h[i].map(fmt).join(",")}`);
                if (val(t.h[i]) > 21) break;
            } else break;
        }
    }

    // Dealer plays if anyone <= 21
    const alive = t.h.some(h => val(h) <= 21);
    if (alive) {
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

    const dv = val(dealer);
    console.log(`🏁 [${code}] Dealer: ${dv}`);

    // Results
    for (let i = 0; i < t.c.length; i++) {
        const p = val(t.h[i]);
        const res = p > 21 ? "LOSE" : dv > 21 ? "WIN" : p > dv ? "WIN" : p === dv ? "PUSH" : "LOSE";
        send(t, i, `RESULT ${res} DEALER ${dealer.map(fmt).join(",")}`);
    }
    await wait(1000);

    // Replay
    const keep = [];
    for (let i = 0; i < t.c.length; i++) {
        if (!t.c[i]) continue;
        send(t, i, "PLAY_AGAIN?");
        if (await resp(t, i) === "YES") keep.push(t.c[i]);
        else t.c[i].close();
    }

    t.c = keep;
    t.h = keep.map(() => []);

    if (t.c.length > 0) {
        console.log(`♻️  [${code}] Next round`);
        await wait(2000);
        game(code);
    } else {
        console.log(`⏸️  [${code}] Empty`);
        delete tables[code];
    }
}

// ===== FUNZIONI AUSILIARIE =====

function all(t, m) {
    t.c.forEach((c, i) => send(t, i, m));
}

function send(t, i, m) {
    if (t.c[i]?.readyState === 1) t.c[i].send(m);
}

function resp(t, i) {
    return new Promise(r => {
        let time = 0;
        const iv = setInterval(() => {
            time += 200;
            if (t.c[i]?.q.length) {
                clearInterval(iv);
                r(t.c[i].q.shift());
            } else if (time >= 30000) {
                clearInterval(iv);
                r("STAND");
            }
        }, 200);
    });
}

function draw(t) {
    if (!t.d.length) {
        console.log("⚠️  Reshuffle");
        for (let s of ["♥", "♦", "♣", "♠"]) 
            for (let v = 1; v <= 13; v++) 
                t.d.push({ v, s });
    }
    return t.d.shift();
}

function val(h) {
    let s = 0, a = 0;
    for (let c of h) {
        if (c.v === 1) { s += 11; a++; }
        else s += c.v >= 11 ? 10 : c.v;
    }
    while (s > 21 && a > 0) { s -= 10; a--; }
    return s;
}

function fmt(c) {
    const v = c.v === 1 ? "A" : c.v === 11 ? "J" : c.v === 12 ? "Q" : c.v === 13 ? "K" : c.v;
    return `${v}${c.s}`;
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}
