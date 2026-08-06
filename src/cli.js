"use strict";

const fs = require("node:fs");
const { createInterface } = require("node:readline/promises");

const API = "https://discordapp.com/api/v8";
const SETTINGS_FILE = "./settings.json";
const REQUEST_TIMEOUT_MS = 10000;

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    } catch (e) {
        return { token: "", status: { text: "Всё успешно", emoji: "✅" } };
    }
}

function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 4));
}

function checkToken(token) {
    return fetch(`${API}/users/@me`, {
        headers: { "Authorization": token },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
}

function setStatus(token, text, emoji) {
    return fetch(`${API}/users/@me/settings`, {
        method: "PATCH",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
            "Content-Type": "application/json",
            "Authorization": token
        },
        body: JSON.stringify({
            custom_status: text || emoji ? {
                text,
                emoji_id: null,
                emoji_name: emoji || null,
                expires_at: null
            } : null
        })
    });
}

async function ask(rl, question, def) {
    const suffix = def ? ` [${def}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();

    return answer || def || "";
}

async function main() {
    const settings = loadSettings();
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log("Discord Status\n");

    const token = await ask(rl, "Discord токен", settings.token);
    const me = await checkToken(token);

    if (!me.ok) {
        console.error(me.status === 401
            ? "Discord отклонил токен (401): он неверный или истёк."
            : `Discord ответил кодом ${me.status} при проверке токена.`);
        rl.close();
        process.exitCode = 1;
        return;
    }

    const user = await me.json();
    const userName = user.global_name || user.username;

    console.log(`Токен рабочий: ${userName}\n`);

    settings.token = token;
    saveSettings(settings);

    const clearAnswer = (await ask(rl, "Очистить статус? (y/N)", "n")).toLowerCase();
    const clear = clearAnswer === "y" || clearAnswer === "yes" || clearAnswer === "да";

    let text = "", emoji = "";

    if (!clear) {
        text = (await ask(rl, "Текст статуса", settings.status.text)).slice(0, 128);
        emoji = await ask(rl, "Эмодзи", settings.status.emoji);
    }

    rl.close();

    const res = await setStatus(token, text, emoji);

    if (!res.ok) {
        console.error(`Токен рабочий (${userName}), но Discord не дал сменить статус (${res.status}).`);
        process.exitCode = 1;
        return;
    }

    if (clear) {
        console.log(`Статус очищен (${userName}).`);
    } else {
        settings.status = { text, emoji };
        saveSettings(settings);
        console.log(`Статус установлен (${userName}): ${emoji} ${text}`.trim());
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error("Не удалось достучаться до Discord: " + e.message);
        process.exitCode = 1;
    });
}

module.exports = { setStatus, checkToken };
