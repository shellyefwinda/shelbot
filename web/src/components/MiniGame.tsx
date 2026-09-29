"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KATEGORI,
  LEVELS,
  MG_UI,
  PEMBUKA,
  PENUTUP,
  POIN,
  TANTANGAN,
  TANTANGAN_AKHIR,
  TINGKAT,
  UMPAN,
  type Kartu,
  type Sikap,
} from "@/content/minigame";
import { t, type Lang } from "@/lib/i18n";

/* Urutan babak: level 1 → tantangan 1 → level 2 → tantangan 2 → level 3 → tantangan akhir → hasil */
type Babak =
  | { jenis: "pembuka" }
  | { jenis: "level"; i: number }
  | { jenis: "tantangan"; i: number }
  | { jenis: "akhir" }
  | { jenis: "hasil" };

type Catatan = {
  soal: string;
  jawabPemain: string;
  jawabBenar: string;
  tepat: boolean;
};

const acak = <X,>(xs: X[]): X[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function MiniGame({ lang }: { lang: Lang }) {
  const id = lang === "id";

  const [babak, setBabak] = useState<Babak>({ jenis: "pembuka" });
  const [skor, setSkor] = useState(0);
  const [kombo, setKombo] = useState(0);
  const [catatan, setCatatan] = useState<Catatan[]>([]);
  const [lihatJawaban, setLihatJawaban] = useState(false);
  const [tersalin, setTersalin] = useState(false);

  /* ---- keadaan satu level ---- */
  const [urutan, setUrutan] = useState<Kartu[]>([]);
  const [ke, setKe] = useState(0);
  const [sisa, setSisa] = useState(0);
  const [kilat, setKilat] = useState<null | { tepat: boolean; teks: string }>(
    null,
  );

  /* ---- keadaan tantangan ---- */
  const [dipilih, setDipilih] = useState<number | null>(null);
  const [pilihTiga, setPilihTiga] = useState<number[]>([]);

  const hidupRef = useRef(true);
  useEffect(() => () => void (hidupRef.current = false), []);

  const mulaiLevel = useCallback((i: number) => {
    setUrutan(acak(LEVELS[i].kartu));
    setKe(0);
    setSisa(LEVELS[i].detik);
    setKilat(null);
    setBabak({ jenis: "level", i });
  }, []);

  const mulai = () => {
    setSkor(0);
    setKombo(0);
    setCatatan([]);
    setLihatJawaban(false);
    mulaiLevel(0);
  };

  /* Babak berikutnya setelah satu level selesai atau waktunya habis. */
  const setelahLevel = useCallback((i: number) => {
    setDipilih(null);
    if (i < TANTANGAN.length) setBabak({ jenis: "tantangan", i });
    else setBabak({ jenis: "akhir" });
  }, []);

  /* Hitung mundur level. */
  useEffect(() => {
    if (babak.jenis !== "level") return;
    if (sisa <= 0) {
      const lompat = setTimeout(() => setelahLevel(babak.i), 0);
      return () => clearTimeout(lompat);
    }
    const detak = setTimeout(() => setSisa((s) => s - 1), 1000);
    return () => clearTimeout(detak);
  }, [babak, sisa, setelahLevel]);

  const jawabKartu = useCallback(
    (pilih: Sikap) => {
      if (babak.jenis !== "level" || kilat) return;
      const kartu = urutan[ke];
      if (!kartu) return;

      const tepat = kartu.jawab === pilih;
      const komboBaru = tepat ? kombo + 1 : 0;
      // Kombo memberi bonus mulai jawaban benar ketiga berturut-turut.
      const bonus = tepat && komboBaru >= 3 ? POIN.komboTiap : 0;

      setKombo(komboBaru);
      setSkor((s) => s + (tepat ? POIN.benar + bonus : POIN.salah));
      setCatatan((c) => [
        ...c,
        {
          soal: t(kartu.teks, lang),
          jawabPemain: t(KATEGORI[pilih], lang),
          jawabBenar: t(KATEGORI[kartu.jawab], lang),
          tepat,
        },
      ]);
      setKilat({ tepat, teks: t(tepat ? UMPAN.benar : UMPAN.salah, lang) });

      setTimeout(() => {
        if (!hidupRef.current) return;
        setKilat(null);
        const lanjut = ke + 1;
        if (lanjut >= urutan.length) {
          // Sisa waktu diubah menjadi poin, sesuai aturan bonus waktu.
          setSkor((s) => s + sisa * POIN.bonusWaktuPerDetik);
          setelahLevel(babak.i);
        } else {
          setKe(lanjut);
        }
      }, 650);
    },
    [babak, ke, kilat, kombo, lang, setelahLevel, sisa, urutan],
  );

  /* Panah kiri-kanan untuk memilih kategori. */
  useEffect(() => {
    if (babak.jenis !== "level") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") jawabKartu("dukung");
      if (e.key === "ArrowRight") jawabKartu("ancam");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [babak, jawabKartu]);

  const jawabTantangan = (i: number, pilih: number) => {
    if (dipilih !== null) return;
    const t2 = TANTANGAN[i];
    const tepat = pilih === t2.benar;
    setDipilih(pilih);
    if (tepat) setSkor((s) => s + POIN.tantangan);
    setCatatan((c) => [
      ...c,
      {
        soal: t(t2.pertanyaan, lang),
        jawabPemain: t(t2.pilihan[pilih], lang),
        jawabBenar: t(t2.pilihan[t2.benar], lang),
        tepat,
      },
    ]);
  };

  const selesaikanAkhir = () => {
    const tepat = pilihTiga.filter(
      (i) => TANTANGAN_AKHIR.pilihan[i].benar,
    ).length;
    setSkor((s) => s + tepat * POIN.benar);
    setCatatan((c) => [
      ...c,
      {
        soal: t(TANTANGAN_AKHIR.skenario, lang),
        jawabPemain: pilihTiga
          .map((i) => t(TANTANGAN_AKHIR.pilihan[i].teks, lang))
          .join(", "),
        jawabBenar: TANTANGAN_AKHIR.pilihan
          .filter((p) => p.benar)
          .map((p) => t(p.teks, lang))
          .join(", "),
        tepat: tepat === 3,
      },
    ]);
    setBabak({ jenis: "hasil" });
  };

  const tingkat = useMemo(
    () => TINGKAT.find((x) => skor >= x.min) ?? TINGKAT[TINGKAT.length - 1],
    [skor],
  );

  /** Bagikan lewat lembar berbagi bawaan perangkat; kalau tidak ada, disalin. */
  async function bagikan() {
    const pesan = id
      ? `Aku dapat ${skor} poin di "Jaga Samarinda!" — ${t(tingkat.gelar, lang)}. Coba juga:`
      : `I scored ${skor} in "Guard Samarinda!" — ${t(tingkat.gelar, lang)}. Try it:`;
    const tautan = typeof window === "undefined" ? "" : window.location.href;

    try {
      if (navigator.share) {
        await navigator.share({ text: pesan, url: tautan });
        return;
      }
      await navigator.clipboard.writeText(`${pesan} ${tautan}`);
      setTersalin(true);
      setTimeout(() => setTersalin(false), 2200);
    } catch {
      /* Dibatalkan sendiri oleh pengunjung, atau papan klip ditutup peramban. */
    }
  }

  /* ---------------- tampilan ---------------- */

  const penuh = babak.jenis === "level" ? LEVELS[babak.i].detik : 0;

  const Papan = (
    <div className="instrumen">
      <p className="flex items-baseline gap-2.5">
        <span className="t-eyebrow !text-[0.62rem]">{t(MG_UI.skor, lang)}</span>
        <span className="angka-besar">{skor}</span>
      </p>
      {babak.jenis === "level" && (
        <div className="flex items-center gap-4">
          {kombo >= 3 && (
            <span className="mono rounded-full border px-2.5 py-1 text-[0.7rem] text-[var(--color-mint)] rule">
              {t(MG_UI.kombo, lang)} ×{kombo}
            </span>
          )}
          <span className="t-eyebrow !text-[0.62rem]">
            {t(MG_UI.waktu, lang)}
          </span>
          {/* Rel waktu: bidang yang menyusut, bukan hanya angka. */}
          <span className="rel-waktu" data-tipis={sisa <= 5 ? "" : undefined}>
            <span style={{ width: `${penuh ? (sisa / penuh) * 100 : 0}%` }} />
          </span>
          <span className="angka-besar w-8 text-right">{sisa}</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="malam konsol">
      {babak.jenis !== "pembuka" && Papan}

      {/* ---- Pembuka ---- */}
      {babak.jenis === "pembuka" && (
        <div className="p-8 sm:p-12">
          <h2 className="t-h1">{t(PEMBUKA.judul, lang)}</h2>
          <p className="t-lead measure mt-6">{t(PEMBUKA.narasi, lang)}</p>
          <p className="t-body measure mt-5 text-[0.925rem]">
            {t(PEMBUKA.petunjuk, lang)}
          </p>
          <button onClick={mulai} className="btn btn-utama mt-9 px-7">
            {t(PEMBUKA.mulai, lang)}
          </button>
        </div>
      )}

      {/* ---- Level ---- */}
      {babak.jenis === "level" && (
        <div className="p-6 sm:p-10">
          <p className="bab">
            <b>
              {String(babak.i + 1).padStart(2, "0")} / {String(LEVELS.length).padStart(2, "0")}
            </b>
            {t(LEVELS[babak.i].judul, lang)}
          </p>
          <p className="t-body measure mt-3 text-[0.925rem]">
            {t(LEVELS[babak.i].instruksi, lang)}
          </p>

          <div className="soal mt-8">
            <p key={ke} className="rise t-h3 max-w-[24ch] font-normal">
              {urutan[ke] ? t(urutan[ke].teks, lang) : ""}
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <button
              onClick={() => jawabKartu("dukung")}
              disabled={!!kilat}
              data-keadaan={
                kilat ? (kilat.tepat ? "tepat" : undefined) : undefined
              }
              className="paddle"
              style={{ "--warna": "var(--color-env)" } as React.CSSProperties}
            >
              {t(KATEGORI.dukung, lang)}
              <kbd aria-hidden>←</kbd>
            </button>
            <button
              onClick={() => jawabKartu("ancam")}
              disabled={!!kilat}
              className="paddle"
              style={{ "--warna": "var(--color-ember)" } as React.CSSProperties}
            >
              {t(KATEGORI.ancam, lang)}
              <kbd aria-hidden>→</kbd>
            </button>
          </div>

          <p
            aria-live="polite"
            className={`mt-5 min-h-6 text-sm ${
              kilat?.tepat
                ? "text-[var(--color-mint)]"
                : "text-[var(--fg-muted)]"
            }`}
          >
            {kilat?.teks ?? ""}
          </p>

          {/* Kemajuan level: satu pip per kartu. */}
          <div className="mt-3 flex items-center gap-3">
            <span className="pip" aria-hidden>
              {urutan.map((k, i) => (
                <i
                  key={k.jawab + String(i)}
                  data-lewat={i < ke ? "" : undefined}
                  data-kini={i === ke ? "" : undefined}
                />
              ))}
            </span>
            <span className="mono text-[0.7rem] text-[var(--fg-faint)]">
              {ke + 1} / {urutan.length}
            </span>
          </div>
        </div>
      )}

      {/* ---- Tantangan Samarinda ---- */}
      {babak.jenis === "tantangan" && (
        <div className="p-6 sm:p-10">
          <p className="t-eyebrow">
            {id ? "Tantangan Samarinda" : "Samarinda Challenge"} {babak.i + 1}
          </p>
          <h2 className="t-h3 measure mt-4 font-normal leading-relaxed">
            {t(TANTANGAN[babak.i].pertanyaan, lang)}
          </h2>

          <ul className="mt-7 space-y-3">
            {TANTANGAN[babak.i].pilihan.map((p, i) => {
              const sudah = dipilih !== null;
              const benar = i === TANTANGAN[babak.i].benar;
              return (
                <li key={i}>
                  <button
                    onClick={() => jawabTantangan(babak.i, i)}
                    disabled={sudah}
                    data-keadaan={
                      sudah && benar
                        ? "tepat"
                        : sudah && i === dipilih
                          ? "salah"
                          : undefined
                    }
                    className="pilihan"
                  >
                    <b aria-hidden>{String.fromCharCode(65 + i)}</b>
                    <span>{t(p, lang)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {dipilih !== null && (
            <div className="rise mt-7">
              <p className="t-body measure text-[0.925rem]">
                {t(TANTANGAN[babak.i].umpan, lang)}
              </p>
              <button
                onClick={() => mulaiLevel(babak.i + 1)}
                className="btn btn-utama mt-6"
              >
                {t(MG_UI.lanjut, lang)}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---- Tantangan terakhir ---- */}
      {babak.jenis === "akhir" && (
        <div className="p-6 sm:p-10">
          <p className="t-eyebrow">
            {id ? "Tantangan Terakhir" : "Final Challenge"} ·{" "}
            {t(MG_UI.pilihTiga, lang)}
          </p>
          <h2 className="t-h3 measure mt-4 font-normal leading-relaxed">
            {t(TANTANGAN_AKHIR.skenario, lang)}
          </h2>

          <ul className="mt-7 grid gap-3 sm:grid-cols-2">
            {TANTANGAN_AKHIR.pilihan.map((p, i) => {
              const on = pilihTiga.includes(i);
              return (
                <li key={i}>
                  <button
                    aria-pressed={on}
                    onClick={() =>
                      setPilihTiga((xs) =>
                        xs.includes(i)
                          ? xs.filter((x) => x !== i)
                          : xs.length < 3
                            ? [...xs, i]
                            : xs,
                      )
                    }
                    className="pilihan"
                  >
                    <b aria-hidden>{on ? "✓" : String.fromCharCode(65 + i)}</b>
                    <span>{t(p.teks, lang)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            onClick={selesaikanAkhir}
            disabled={pilihTiga.length !== 3}
            className="btn btn-utama mt-8 disabled:opacity-35"
          >
            {t(MG_UI.lanjut, lang)} ({pilihTiga.length}/3)
          </button>
        </div>
      )}

      {/* ---- Hasil ---- */}
      {babak.jenis === "hasil" && (
        <div className="p-8 sm:p-12">
          <p className="t-eyebrow">{t(MG_UI.hasil, lang)}</p>
          <p className="mono mt-5 text-6xl leading-none">{skor}</p>
          <h2 className="t-h2 mt-4">{t(tingkat.gelar, lang)}</h2>
          <p className="t-lead measure mt-4">{t(tingkat.pesan, lang)}</p>

          <div className="mt-9 flex flex-wrap gap-3">
            <button onClick={mulai} className="btn btn-utama">
              {t(MG_UI.ulang, lang)}
            </button>
            <button onClick={bagikan} className="btn btn-garis">
              {tersalin ? t(MG_UI.tersalin, lang) : t(MG_UI.bagikan, lang)}
            </button>
            <button
              onClick={() => setLihatJawaban((v) => !v)}
              aria-expanded={lihatJawaban}
              className="btn btn-garis"
            >
              {t(MG_UI.jawaban, lang)}
            </button>
            {/* Link, bukan <a>: awalan situs (/shelbot) ikut ditambahkan. */}
            <Link href={`/${lang}/samarinda/`} className="btn btn-garis">
              {t(MG_UI.jelajah, lang)}
            </Link>
          </div>

          {lihatJawaban && (
            <ul className="rise mt-10 overflow-hidden rounded-2xl border rule">
              {catatan.map((c, i) => (
                <li
                  key={i}
                  className="border-b p-4 last:border-b-0 rule"
                  style={
                    {
                      borderLeft: `3px solid ${c.tepat ? "var(--color-mint)" : "var(--color-ember)"}`,
                    } as React.CSSProperties
                  }
                >
                  <p className="text-[0.925rem]">{c.soal}</p>
                  <p className="mt-1.5 text-[0.85rem] text-[var(--fg-muted)]">
                    <span
                      aria-hidden
                      className="mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle"
                      style={{
                        background: c.tepat
                          ? "var(--color-mint)"
                          : "var(--color-ember)",
                      }}
                    />
                    {c.jawabPemain}
                    {!c.tepat && (
                      <>
                        {" · "}
                        {t(MG_UI.benarnya, lang)}: {c.jawabBenar}
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <p className="t-body measure mt-12 text-[0.925rem]">
            {t(PENUTUP, lang)}
          </p>
        </div>
      )}
    </div>
  );
}
