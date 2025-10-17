// index.js
import dotenv from "dotenv";
dotenv.config();

import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import { WebcastPushConnection } from "tiktok-live-connector";
import fetch from "node-fetch";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;
const SIGN_SERVER_URL = process.env.SIGN_SERVER_URL || ""; // optional
const ENABLE_UPLOAD_CHECK = (process.env.ENABLE_UPLOAD_CHECK || "true").toLowerCase() === "true";
const UPLOAD_CHECK_INTERVAL = parseInt(process.env.UPLOAD_CHECK_INTERVAL || "300", 10);

if (!DISCORD_TOKEN || !CHANNEL_ID || !TIKTOK_USERNAME) {
  console.error("ERROR: Pastikan DISCORD_TOKEN, DISCORD_CHANNEL_ID, dan TIKTOK_USERNAME sudah di-set di environment.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let lastVideoId = null;
let liveConn = null;
let isConnectedToRoom = false;

client.once("clientReady", () => {
  // new discord.js v15 warning handled: use clientReady instead of ready in newer versions
});
client.once("ready", async () => {
  console.log(`✅ Bot Discord siap: ${client.user.tag}`);
  startAllTasks().catch(err => console.error("startAllTasks error:", err));
});

/**
 * Buat koneksi ke TikTok Live dengan retry + optional sign server
 */
async function startTikTokLive() {
  // cleanup koneksi lama bila ada
  if (liveConn) {
    try { liveConn.disconnect(); } catch (_) {}
    liveConn = null;
    isConnectedToRoom = false;
  }

  const options = {};
  if (SIGN_SERVER_URL) {
    // tiktok-live-connector akan menggunakan opsi signServerHost jika diberikan
    options.signServerHost = SIGN_SERVER_URL;
    console.log("Menggunakan Sign Server:", SIGN_SERVER_URL);
  }

  liveConn = new WebcastPushConnection(TIKTOK_USERNAME, options);

  try {
    console.log("🔍 Mencoba connect ke TikTok Live...");
    const state = await liveConn.connect();
    isConnectedToRoom = true;
    console.log("✅ Terhubung ke room:", state.roomId);

    liveConn.on("streamStart", async () => {
      console.log("🟢 Event: streamStart diterima.");
      await sendLiveNotification();
    });

    liveConn.on("streamEnd", () => {
      console.log("🔴 Event: streamEnd diterima.");
      isConnectedToRoom = false;
    });

    liveConn.on("streamUpdate", (d) => {
      // optional debug
      // console.log("streamUpdate", d);
    });

    liveConn.on("error", (err) => {
      console.warn("⚠️ TikTok live connection error:", err);
    });

    // attach some other useful events if mau (gift/chat/like) — library akan memicu event sesuai support
    liveConn.on("roomUserSeq", (data) => {
      // contoh: jumlah user (jika tersedia)
      // console.log("roomUserSeq:", data);
    });

    // jangan auto return — koneksi aktif bakal bertahan
  } catch (err) {
    isConnectedToRoom = false;
    // Tangani common Sign API error (server sign dapat mengembalikan 500 atau 403)
    console.error("Gagal connect TikTok Live:", err && err.message ? err.message : err);
    // retry dengan backoff
    const retryAfter = 30; // detik
    console.log(`Mencoba reconnect dalam ${retryAfter}s...`);
    setTimeout(() => startTikTokLive(), retryAfter * 1000);
  }
}

/**
 * Kirim notifikasi LIVE ke Discord (embed sederhana bahasa Indonesia)
 */
async function sendLiveNotification() {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.warn("Channel Discord tidak ditemukan:", CHANNEL_ID);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`${TIKTOK_USERNAME} SEDANG LIVE di TikTok!`)
      .setURL(`https://www.tiktok.com/@${TIKTOK_USERNAME}/live`)
      .setDescription(`🔴 ${TIKTOK_USERNAME} baru saja mulai siaran langsung!\nKlik untuk menonton.`)
      .setTimestamp()
      .setFooter({ text: "TikTok Notifier" });

    await channel.send({ content: "@here", embeds: [embed] });
    console.log("📣 Notifikasi LIVE terkirim ke Discord.");
  } catch (err) {
    console.error("Gagal mengirim notifikasi ke Discord:", err);
  }
}

/**
 * Cek upload video baru (scrape simple)
 */
async function fetchLatestVideoId() {
  try {
    const res = await fetch(`https://www.tiktok.com/@${TIKTOK_USERNAME}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/\/video\/(\d+)/);
    if (m) return m[1];
    // fallback: extract itemId in JSON
    const m2 = html.match(/"itemId":"(\d+)"/);
    if (m2) return m2[1];
    return null;
  } catch (err) {
    console.warn("fetchLatestVideoId error:", err.message || err);
    return null;
  }
}

async function startUploadChecker() {
  if (!ENABLE_UPLOAD_CHECK) return;
  console.log("🕵️ Mulai memeriksa upload baru setiap", UPLOAD_CHECK_INTERVAL, "detik");
  // inisialisasi terakhir
  lastVideoId = await fetchLatestVideoId();
  if (lastVideoId) console.log("Initial latest video id:", lastVideoId);

  setInterval(async () => {
    try {
      const vid = await fetchLatestVideoId();
      if (vid && vid !== lastVideoId) {
        lastVideoId = vid;
        await sendUploadNotification(vid);
      }
    } catch (err) {
      console.warn("Upload check error:", err);
    }
  }, UPLOAD_CHECK_INTERVAL * 1000);
}

async function sendUploadNotification(videoId) {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return;
    const url = `https://www.tiktok.com/@${TIKTOK_USERNAME}/video/${videoId}`;
    const embed = new EmbedBuilder()
      .setTitle(`${TIKTOK_USERNAME} baru mengunggah video!`)
      .setURL(url)
      .setDescription(`✨ Video baru telah diunggah. [Tonton di sini](${url})`)
      .setTimestamp()
      .setFooter({ text: "TikTok Notifier" });
    await channel.send({ embeds: [embed] });
    console.log("📣 Notifikasi upload terkirim:", url);
  } catch (err) {
    console.error("Gagal mengirim notifikasi upload:", err);
  }
}

/**
 * Start both tasks
 */
async function startAllTasks() {
  // mulai koneksi TikTok Live (retry akan di-handle di dalam fungsi)
  startTikTokLive().catch(e => console.error("startTikTokLive crashed:", e));
  // mulai checker upload
  startUploadChecker().catch(e => console.error("startUploadChecker crashed:", e));
}

// login Discord dan kick-off
client.login(DISCORD_TOKEN).catch(err => {
  console.error("Gagal login Discord:", err);
  process.exit(1);
});
