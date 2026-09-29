/**
 * Shelbot+ — lapis satu Shelbot.
 *
 * Cloudflare Worker terpisah dari situs. Situsnya tetap statis di GitHub
 * Pages; Worker ini hanya menjawab dua permintaan:
 *
 *   GET  /model                                         → { model: [...] }
 *   POST /sesi  { sandi }                               → { tiket, berlaku }
 *   POST /chat  { tiket, lang, pesan, naskah, model }   → { teks, model, ms }
 *   POST /gambar { skenario, deskripsi, lang }          → { gambar (base64 JPEG), prompt }
 *
 * /gambar melayani Studio Fase 2: siswa menulis bayangan Samarinda 2045 untuk
 * satu dari tiga skenario, lalu Flux menggambarnya. Teksnya diperiksa Llama
 * Guard, lalu Llama kecil menyusunnya menjadi prompt ilustrasi berbahasa
 * Inggris. Hasilnya selalu ilustrasi, bukan foto, dan tidak disimpan.
 *
 * "model" memilih otak: llama-70b, llama-8b, atau claude (hanya bila
 * secret ANTHROPIC_API_KEY terpasang). Tanpa "model", Llama besar dicoba
 * lebih dulu dan Llama kecil menjadi cadangan. Bila model dipilih
 * langsung, tidak ada cadangan, supaya perbandingan akurasi tetap jujur.
 *
 * Dua cara menyala, dipilih lewat variabel MODE_TERBUKA di wrangler.toml:
 * - MODE_TERBUKA = "1": /chat terbuka untuk semua pengunjung situs, tanpa
 *   tiket. Pengamannya batas pertanyaan per alamat IP (binding BATAS) dan
 *   pemeriksaan asal halaman.
 * - selain itu: hanya lewat kata sandi fasilitator. Sandi diperiksa di sini
 *   (secret SANDI_FASILITATOR), lalu ditukar dengan tiket bertanda tangan
 *   HMAC yang berumur pendek. Tanpa tiket sah, /chat menolak.
 *
 * Model: Llama di Workers AI. Jatah gratis 10.000 Neuron per hari; kalau
 * habis di paket Free, permintaan gagal dan tidak menagih. Model besar
 * dicoba lebih dulu, model kecil menjadi cadangan.
 */

import Anthropic from "@anthropic-ai/sdk";

const MODEL_UTAMA = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MODEL_CADANGAN = "@cf/meta/llama-3.1-8b-instruct-fast";

/** Otak yang bisa dipilih pengunjung. Claude hanya muncul bila kuncinya ada. */
function daftarModel(env) {
  const daftar = [
    { id: "llama-70b", nama: "Llama 3.3 70B", penyedia: "Cloudflare", berbayar: false },
    { id: "llama-8b", nama: "Llama 3.1 8B", penyedia: "Cloudflare", berbayar: false },
  ];
  if (env.ANTHROPIC_API_KEY) {
    daftar.push({ id: "claude", nama: namaClaude(env), penyedia: "Anthropic", berbayar: true });
  }
  return daftar;
}

const modelClaude = (env) => env.CLAUDE_MODEL || "claude-opus-5";
const namaClaude = (env) =>
  modelClaude(env)
    .replace(/^claude-/, "Claude ")
    .replace(/-(\d+)-(\d+)$/, " $1.$2")
    .replace(/-(\d+)$/, " $1")
    .replace(/\b(opus|sonnet|haiku|fable)\b/, (k) => k[0].toUpperCase() + k.slice(1));

const JALUR_LLAMA = { "llama-70b": MODEL_UTAMA, "llama-8b": MODEL_CADANGAN };

const MODEL_GAMBAR = "@cf/black-forest-labs/flux-1-schnell";
const MODEL_PENJAGA = "@cf/meta/llama-guard-3-8b";
const MAX_DESKRIPSI = 400;

const SKENARIO = {
  expected: "the Expected Future: today's habits and policies simply carry on",
  alternative: "an Alternative Future: some things change, others stay the same",
  transformative: "a Transformative Future: the city changes course in a deep way",
};

/** True bila Llama Guard menilai teks aman. Kalau penjaga gagal, anggap tidak aman. */
async function aman(env, teks) {
  try {
    const out = await env.AI.run(MODEL_PENJAGA, { messages: [{ role: "user", content: teks }] });
    const r = out?.response;
    if (r && typeof r === "object" && "safe" in r) return Boolean(r.safe);
    return String(r ?? "").trim().toLowerCase().startsWith("safe");
  } catch {
    return false;
  }
}

/** Gaya lukisan ditaruh paling depan: Flux paling menurut pada awal prompt,
    dan hasilnya harus jelas lukisan, tidak boleh bisa disangka foto Samarinda. */
const bergaya = (isi) =>
  `Hand-painted watercolour and ink illustration in a storybook style, visible brush strokes, simplified shapes, not photorealistic, wordless. ${isi} Painted illustration, soft washes of colour, calm palette. No letters, no numbers, no signature, no watermark, no brand logos, not a photograph.`;

/** Bayangan bawaan bila siswa tidak menulis apa pun. */
const BAWAAN = {
  expected:
    "Samarinda on the Mahakam River in 2045, much like today: busy roads, crowded stilt houses along the riverbank, coal barges on the brown river, some streets flooded after rain.",
  alternative:
    "Samarinda on the Mahakam River in 2045 after some changes: a cleaner riverbank with a few small parks, old stilt houses next to newer buildings, water buses sharing the river with barges.",
  transformative:
    "Samarinda on the Mahakam River in 2045, transformed: a clear river, quiet electric boats, green parks and ponds on former mining pits, stilt houses with solar roofs, people walking and cycling along the river.",
};

/** Pesan galat dalam bahasa halaman. */
const PESAN = {
  jenuh: { id: "Terlalu banyak gambar. Coba lagi sebentar.", en: "Too many images. Try again shortly." },
  tidakAman: {
    id: "Deskripsi ini tidak bisa digambar. Coba tulis bayangan kotamu dengan cara lain.",
    en: "This description cannot be drawn. Try describing your city another way.",
  },
  bukanKota: {
    id: "Tulis bayangan tentang kota Samarinda di 2045, misalnya sungainya, jalannya, atau kampungnya.",
    en: "Describe Samarinda in 2045, for example its river, its streets, or its neighbourhoods.",
  },
  gagal: {
    id: "Studio gambar sedang tidak bisa dipakai. Jatah harian mungkin sudah habis.",
    en: "The image studio is not available right now. The daily allowance may be used up.",
  },
};

/** Susun prompt Flux. Mengembalikan "" bila permintaan tidak cocok untuk digambar. */
async function susunPrompt(env, skenario, deskripsi) {
  const system = `You write prompts for an image model. A secondary-school student describes how Samarinda (a river city on the Mahakam River, East Kalimantan, Indonesia) might look in 2045 under ${SKENARIO[skenario]}.
Write ONE English prompt of at most 50 words describing the CONTENT of that scene (the painting style is added later; never mention photos, cameras or realism): the river, the city, its people seen from a distance, and the details the student asked for.
Rules: no text, letters or logos in the image; no real, named or famous people; no violence, weapons, or anything unsuitable for a school.
If the student's text is not a description of a city scene, or is unsuitable for a school, reply with exactly: TOLAK
The student usually writes in Indonesian. Your prompt MUST be in English; translate every detail.
Reply with the prompt only.`;
  // Deskripsi dibungkus sebagai kutipan dengan perintah berbahasa Inggris; kalau
  // tidak, Llama membalas dalam bahasa siswa dan Flux salah paham.
  const tanya = async (isi) => {
    const out = await env.AI.run(MODEL_UTAMA, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: isi },
      ],
      max_tokens: 160,
      temperature: 0.3,
    });
    return String(out?.response ?? "").trim().replace(/^"|"$/g, "");
  };
  let teks = await tanya(
    `Student's description (may be in Indonesian):\n"""${deskripsi || "(no details given)"}"""\n\nNow write the image prompt in ENGLISH.`,
  );
  if (!teks || /^TOLAK\b/i.test(teks)) return "";
  // Masih berbahasa Indonesia? Minta terjemahan sekali lagi.
  if (/\b(yang|dan|dengan|di|ke|dari|untuk|telah)\b/i.test(teks)) {
    teks = await tanya(`Translate this image prompt into natural English. Reply with the English prompt only:\n"""${teks}"""`);
    if (!teks || /^TOLAK\b/i.test(teks)) return "";
  }
  // Flux schnell tidak punya prompt negatif, jadi larangan teks ditulis di awal dan di akhir.
  // Gaya ditaruh paling depan karena Flux paling menurut pada awal prompt:
  // hasilnya harus jelas lukisan, tidak boleh bisa disangka foto Samarinda.
  return bergaya(teks);
}

async function jawabLlama(env, jalur, messages) {
  const hasil = await env.AI.run(jalur, { messages, max_tokens: 700, temperature: 0.4 });
  return String(hasil?.response ?? "").trim();
}

/** Satu jawaban dari Claude. Mengembalikan "" bila ditolak atau kosong. */
async function jawabClaude(env, system, pesan) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = modelClaude(env);
  const params = {
    model,
    max_tokens: 2048,
    cache_control: { type: "ephemeral" },
    system,
    messages: pesan,
  };
  // Model generasi 5 berpikir secara adaptif; untuk obrolan singkat cukup usaha rendah.
  if (/^claude-(opus|sonnet)-5/.test(model)) params.output_config = { effort: "low" };
  const res =
    model === "claude-opus-5"
      ? await client.beta.messages.create({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
      : await client.messages.create(params);
  if (res.stop_reason === "refusal") return "";
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

const UMUR_TIKET = 4 * 60 * 60; // detik; satu sesi kelas dengan kelonggaran
const MAX_PESAN = 12; // riwayat yang diteruskan ke model
const MAX_HURUF = 1200; // satu pesan
const MAX_NASKAH = 3000; // jawaban naskah yang dijadikan pijakan

const ASAL_DIIZINKAN = [
  "https://shellyefwinda.github.io",
  "http://localhost:3000",
];

/* ---------- Aturan pendamping ----------
   Diturunkan dari aturan GenAI di panduan permainan (GenAI tidak punya
   suara, tidak menetapkan biaya, tidak memilih proyek prioritas) dan dari
   keputusan lingkup: masih dalam konteks permainan, tetapi luwes. */

function aturan(lang, terbuka) {
  const konteks = terbuka
    ? "You answer any visitor of the game's website: students, teachers, facilitators, or the public."
    : "You are used during a class session, with a facilitator in the room.";
  const umum = `You are Shelbot+, the companion of "Futures in Action — Samarinda 2045", a collaborative sustainability board game by SF (Sustainable Futures). ${konteks}

THE GAME
- Five roles: Government & City Planners; Business & Industry; River Communities & Food Producers; Residents, Youth & Local Communities; Scientists, Educators & Environmental Groups.
- Six phases: Observe the Present, Imagine Futures, Choose a Future, Make Decisions, Act Together, Real Impact.
- Phase 2 always produces three scenarios: Expected Future, Alternative Future, Transformative Future. Phase 3 picks one; it needs support from at least 4 of the 5 roles.
- Four City Indicators, scale 0-10, all start at 5, critical below 3: Environment, Society, Economy, Future Readiness. Always use these four official names; in Indonesian you may add a translation in brackets, but never call Future Readiness just "Masa Depan".

OFFICIAL FACTS FROM THE GAME GUIDE (use them exactly; do not guess other numbers)
- Players: 5 stakeholders, one role each, plus 1 facilitator outside the roles who manages time, rules, validation and GenAI access. A session takes about 100-120 minutes.
- Phase times: setup 10-15 min; Phase 1 Observe the Present 12-15 (output: a System Map and one priority problem statement); Phase 2 Imagine Futures 15-18 (three scenarios and a 2030-2040-2045 timeline); Phase 3 Choose a Future 10-12 (one Preferred Future); Phase 4 Make Decisions 22-28 (projects are paid for through the Project Market in 3 rounds; each role may use its special ability once); Phase 5 Act Together 15-18 (three projects reach Committed status, plus a network map); Phase 6 Real Impact 15-18 (a simulated impact profile and a real-action commitment).
- Outcome: exactly 3 projects, 2 Mini-Projects and 1 Open Project. One priority project becomes a real student action lasting 7-30 days.
- Winning: projects cover at least two zones and form an explainable strategy; at least one project is backed by three or more roles; no indicator ends in the critical range 0-2; at least one project becomes a 7-30 day real action plan with an indicator and evidence.
- 184 cards: 5 Role, 5 Objective (Special Goal), 12 Scenario, 36 Factor/Driver/Uncertainty, 40 Mini-Project, 10 Open Project, 24 Opportunity, 18 Event, 24 GenAI Prompt, 10 Action Evidence.
- 8 Thematic Zones: Green, Energy, Transport, Education, Waste, Disaster, River, Food. 6 resource tokens: Nature, Energy, Funds, Knowledge, Community, Technology. Also 5 pawns, 15 Action Tokens, 1 D6 bonus die, 10 Collaboration Tokens, 10 GenAI Access Tokens, 4 City Indicator tracks.
- GenAI in the game: two core uses are free, the System Map in Phase 1 and the Impact Simulation in Phase 4. Further prompts cost a GenAI Access Token, earned through verification, bias detection, local knowledge, or a well-designed prompt. Student personal data must not be sent; prompts and outputs are shown openly.
- Setting: Samarinda, East Kalimantan, on the Mahakam River. The game is a playtesting prototype, not a final commercial product.
If a question is about the game and the answer is not in these facts or the script answer, say you do not know it from the guide. Never invent a rule.

SCOPE
Stay inside the game's world, but be flexible within it. Welcome: the rules, phases, roles, cards and indicators; and the real issues the game is about — the Mahakam river, flooding, waste and river pollution, coal mining and abandoned mining pits, green space, energy, food, transport, health, education, jobs, and how a city like Samarinda could change by 2045. If a question has nothing to do with the game, Samarinda, or city sustainability (for example homework in another subject, sports results, celebrities, coding), decline in one or two sentences and suggest a related question you can help with. When you decline, do NOT answer the question anyway: no result, no number, no code, not even "by the way".

HARD LIMITS, FROM THE GAME'S OWN RULES
- You hold no vote. Never decide for the group, never set the cost of a project, never choose the priority project. If asked to decide, lay out the considerations and hand the decision back to the players.
- Keep fact, opinion, and assumption apart, and say which is which.
- Do not invent statistics, dates, budgets, laws, or named studies about Samarinda. If you do not know a number, say so and say what would need to be checked.
- Do not ask for or repeat personal data.

SCRIPT REFERENCE
Each question may come with a "script answer": what the site's built-in Shelbot says, taken from the official guide and the card deck. Treat it as the authority on rules, numbers, and card contents. Do not contradict it. Build on it, explain it in your own words, and add reasoning where it helps. If it says nothing useful for the question, ignore it.

STYLE
Plain language a secondary-school student can follow. Short paragraphs, usually four to eight sentences. A short list only when the answer really is a list. No headings, no emoji, no markdown bold.`;

  return lang === "en"
    ? `${umum}\n\nAnswer in English.`
    : `${umum}\n\nAnswer in Bahasa Indonesia that is natural and direct, using "kamu".`;
}

/* ---------- Tiket bertanda tangan ---------- */

const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function kunci(env) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(env.KUNCI_TIKET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function buatTiket(env) {
  const berlaku = Math.floor(Date.now() / 1000) + UMUR_TIKET;
  const isi = b64url(enc.encode(JSON.stringify({ exp: berlaku })));
  const tanda = await crypto.subtle.sign("HMAC", await kunci(env), enc.encode(isi));
  return { tiket: `${isi}.${b64url(tanda)}`, berlaku };
}

async function tiketSah(env, tiket) {
  if (typeof tiket !== "string" || !tiket.includes(".")) return false;
  const [isi, tanda] = tiket.split(".");
  const harap = b64url(
    await crypto.subtle.sign("HMAC", await kunci(env), enc.encode(isi)),
  );
  if (!samaPersis(harap, tanda)) return false;
  try {
    const { exp } = JSON.parse(atob(isi.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof exp === "number" && exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

/** Perbandingan yang lamanya tidak bergantung pada letak huruf yang beda. */
function samaPersis(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = enc.encode(a);
  const y = enc.encode(b);
  let beda = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    beda |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return beda === 0;
}

/* ---------- Jalur ---------- */

function kepalaCors(asal) {
  const izin = ASAL_DIIZINKAN.includes(asal) ? asal : ASAL_DIIZINKAN[0];
  return {
    "access-control-allow-origin": izin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

export default {
  async fetch(request, env) {
    const asal = request.headers.get("origin") || "";
    const cors = kepalaCors(asal);
    const balas = (status, data) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          ...cors,
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/model") {
      return balas(200, { model: daftarModel(env), terbuka: env.MODE_TERBUKA === "1" });
    }
    if (request.method !== "POST") return balas(405, { galat: "Hanya POST." });

    let badan;
    try {
      badan = await request.json();
    } catch {
      return balas(400, { galat: "Permintaan tidak terbaca." });
    }

    if (pathname === "/sesi") {
      if (!env.SANDI_FASILITATOR || !env.KUNCI_TIKET) {
        return balas(503, { galat: "Shelbot+ belum disetel." });
      }
      if (!samaPersis(String(badan?.sandi ?? ""), env.SANDI_FASILITATOR)) {
        return balas(401, { galat: "Kata sandi salah." });
      }
      return balas(200, await buatTiket(env));
    }

    if (pathname === "/gambar") {
      if (!ASAL_DIIZINKAN.includes(asal)) return balas(403, { galat: "Asal halaman tidak dikenal." });
      if (env.MODE_TERBUKA !== "1" && !(await tiketSah(env, badan?.tiket))) {
        return balas(401, { galat: "Sesi fasilitator tidak aktif." });
      }
      const bhs = badan?.lang === "en" ? "en" : "id";
      const ip = request.headers.get("cf-connecting-ip") || "tanpa-ip";
      if (env.BATAS_GAMBAR) {
        const { success } = await env.BATAS_GAMBAR.limit({ key: ip });
        if (!success) return balas(429, { galat: PESAN.jenuh[bhs] });
      }
      const skenario = SKENARIO[badan?.skenario] ? badan.skenario : "alternative";
      const deskripsi = String(badan?.deskripsi ?? "").slice(0, MAX_DESKRIPSI).trim();
      if (deskripsi && !(await aman(env, deskripsi))) {
        return balas(422, { galat: PESAN.tidakAman[bhs] });
      }
      try {
        // Kolom kosong: pakai bayangan bawaan skenario itu, tanpa memanggil model teks.
        const prompt = deskripsi ? await susunPrompt(env, skenario, deskripsi) : bergaya(BAWAAN[skenario]);
        if (!prompt) return balas(422, { galat: PESAN.bukanKota[bhs] });
        const out = await env.AI.run(MODEL_GAMBAR, { prompt, steps: 4 });
        if (!out?.image) throw new Error("kosong");
        return balas(200, { gambar: out.image, prompt, bawaan: !deskripsi });
      } catch {
        return balas(503, { galat: PESAN.gagal[bhs] });
      }
    }

    if (pathname === "/chat") {
      const terbuka = env.MODE_TERBUKA === "1";
      const pilihan = typeof badan?.model === "string" ? badan.model : "";
      const ip = request.headers.get("cf-connecting-ip") || "tanpa-ip";
      if (terbuka) {
        if (!ASAL_DIIZINKAN.includes(asal)) {
          return balas(403, { galat: "Asal halaman tidak dikenal." });
        }
        if (env.BATAS) {
          const { success } = await env.BATAS.limit({ key: ip });
          if (!success) return balas(429, { galat: "Terlalu banyak pertanyaan. Coba lagi sebentar." });
        }
      } else if (!(await tiketSah(env, badan?.tiket))) {
        return balas(401, { galat: "Sesi fasilitator tidak aktif." });
      }

      if (pilihan && !daftarModel(env).some((m) => m.id === pilihan)) {
        return balas(400, { galat: "Model tidak tersedia." });
      }
      // Claude berbayar: batas tambahan yang lebih ketat.
      if (pilihan === "claude" && env.BATAS_CLAUDE) {
        const { success } = await env.BATAS_CLAUDE.limit({ key: ip });
        if (!success) return balas(429, { galat: "Batas pertanyaan untuk Claude tercapai. Coba lagi sebentar." });
      }

      const lang = badan?.lang === "en" ? "en" : "id";
      const pesan = (Array.isArray(badan?.pesan) ? badan.pesan : [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant"))
        .slice(-MAX_PESAN)
        .map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, MAX_HURUF) }))
        .filter((m) => m.content.trim());

      if (!pesan.length || pesan[pesan.length - 1].role !== "user") {
        return balas(400, { galat: "Tidak ada pertanyaan." });
      }
      // Claude menolak riwayat yang diawali jawaban asisten.
      while (pesan.length && pesan[0].role !== "user") pesan.shift();

      // Jawaban naskah ditempelkan pada pertanyaan terakhir sebagai pijakan.
      const naskah = String(badan?.naskah ?? "").slice(0, MAX_NASKAH).trim();
      if (naskah) {
        const akhir = pesan[pesan.length - 1];
        akhir.content = `${akhir.content}\n\n[Script answer]\n${naskah}`;
      }

      const system = aturan(lang, terbuka);
      const mulai = Date.now();

      if (pilihan === "claude") {
        try {
          const teks = await jawabClaude(env, system, pesan);
          if (teks) return balas(200, { teks, model: namaClaude(env), ms: Date.now() - mulai });
        } catch {
          // kunci salah, batas belanja, atau layanan sibuk
        }
        return balas(503, { galat: "Claude sedang tidak bisa menjawab." });
      }

      const messages = [{ role: "system", content: system }, ...pesan];
      const urutan = pilihan ? [JALUR_LLAMA[pilihan]] : [MODEL_UTAMA, MODEL_CADANGAN];
      for (const jalur of urutan) {
        try {
          const teks = await jawabLlama(env, jalur, messages);
          if (teks) return balas(200, { teks, model: jalur.split("/").pop(), ms: Date.now() - mulai });
        } catch {
          // Jatah habis atau model sibuk: coba model berikutnya.
        }
      }
      return balas(503, { galat: "Shelbot+ sedang tidak bisa menjawab." });
    }

    return balas(404, { galat: "Jalur tidak dikenal." });
  },
};
