import { getStore } from "@netlify/blobs";

const CAP = 5;                                   // kursi per meja
const VIP = [1, 2, 3, 4, 6];                     // meja oranye (guru)
const REG = [5,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25]; // meja hijau (siswa)
const store = getStore({ name: "acara", consistency: "strong" });

const J = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json" } });
const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const csvf = (v) => '"' + String(/^[=+\-@]/.test(String(v)) ? "'" + v : v).replace(/"/g, '""') + '"';

function usage(regs) {
  const u = {};
  for (const r of regs) for (const x of [...r.plan.guru, ...r.plan.siswa]) u[x.t] = (u[x.t] || 0) + x.n;
  return u;
}
function plan(n, pool, u) {
  if (n < 1) return [];
  for (const t of pool) if (CAP - (u[t] || 0) >= n) return [{ t, n }];   // satu meja kalau muat
  const o = []; let left = n;
  for (const t of pool) {
    const f = CAP - (u[t] || 0);
    if (f > 0) { const k = Math.min(f, left); o.push({ t, n: k }); left -= k; if (!left) return o; }
  }
  return null;
}
const pub = (r) => ({ school: r.school, siswa: r.siswa, guru: r.guru, plan: r.plan });
async function load() {
  const e = await store.getWithMetadata("state", { type: "json" });
  return e ? { regs: e.data.regs, etag: e.etag } : { regs: [], etag: null };
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\//, "");

  if (path === "find") {
    const { regs } = await load();
    const r = regs.find((x) => x.nm === norm(url.searchParams.get("q")));
    return r ? J({ ok: 1, data: pub(r) }) : J({ err: "Sekolah belum terdaftar." }, 404);
  }

  if (path === "reg" && req.method === "POST") {
    let d; try { d = await req.json(); } catch { return J({ err: "Data tidak valid." }, 400); }
    const school = String(d.school || "").trim(), ns = +d.siswa, ng = +d.guru || 0, gp = String(d.gp || "").trim();
    if (!school || school.length > 100 || !(ns >= 1 && ns <= 100) || !(ng >= 0 && ng <= 25)) return J({ err: "Data tidak valid. Periksa asal sekolah dan jumlah." }, 400);
    if (!Array.isArray(d.stu) || d.stu.length !== ns) return J({ err: "Data siswa harus lengkap." }, 400);
    const stu = [];
    for (const s of d.stu) {
      const n = String(s.n || "").trim(), p = String(s.p || "").trim();
      if (!n || !/^[0-9+\-\s]{8,16}$/.test(p)) return J({ err: "Nama dan no. HP siswa harus diisi dengan benar." }, 400);
      stu.push({ n: n.slice(0, 80), p });
    }
    for (let i = 0; i < 10; i++) {                 // coba ulang kalau ada pendaftar lain di waktu yang sama
      const { regs, etag } = await load();
      const ex = regs.find((x) => x.nm === norm(school));
      if (ex) return J({ ok: 1, dup: 1, data: pub(ex) });
      const u = usage(regs);
      let g = plan(ng, VIP, u); if (g === null) g = plan(ng, REG, u);
      if (g) for (const x of g) u[x.t] = (u[x.t] || 0) + x.n;
      let s = plan(ns, REG, u); if (s === null) s = plan(ns, VIP, u);
      if (!g || !s) return J({ err: "Kursi tidak cukup. Hubungi panitia." }, 409);
      const rec = { nm: norm(school), school, siswa: ns, guru: ng, gp, stu, plan: { guru: g, siswa: s }, ts: Date.now() };
      const body = { regs: [...regs, rec] };
      const w = etag ? await store.setJSON("state", body, { onlyIfMatch: etag }) : await store.setJSON("state", body, { onlyIfNew: true });
      if (w.modified) return J({ ok: 1, data: pub(rec) });
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 300));
    }
    return J({ err: "Server sibuk, coba lagi." }, 503);
  }

  if (path === "admin") {
    const pass = process.env.ADMIN_PASS;
    if (!pass || url.searchParams.get("key") !== pass) return new Response("Akses ditolak", { status: 403 });
    const { regs } = await load();
    const mj = (p) => p.map((x) => x.t).join("/");
    if (url.searchParams.has("csv")) {
      let c = "Sekolah,Siswa,Guru,HP Pendamping,Meja Guru,Meja Siswa,Nama Siswa,HP Siswa\n";
      for (const r of regs) for (const s of r.stu) c += [csvf(r.school), r.siswa, r.guru, csvf(r.gp), csvf(mj(r.plan.guru)), csvf(mj(r.plan.siswa)), csvf(s.n), csvf(s.p)].join(",") + "\n";
      return new Response(c, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=peserta.csv" } });
    }
    const u = usage(regs), tot = regs.reduce((a, r) => a + r.siswa + r.guru, 0);
    const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:15px system-ui;padding:16px"><h2>Panitia</h2>
<p>${regs.length} rombongan, ${tot} orang. <a href="?key=${encodeURIComponent(pass)}&csv=1">Unduh CSV</a></p>
<table border=1 cellpadding=6 style="border-collapse:collapse"><tr><th>Sekolah<th>Siswa<th>Guru<th>Meja guru<th>Meja siswa
${regs.map((r) => `<tr><td>${esc(r.school)}<td>${r.siswa}<td>${r.guru}<td>${mj(r.plan.guru)}<td>${mj(r.plan.siswa)}`).join("")}</table>
<h3>Terisi per meja</h3><p>${[...VIP, ...REG].map((t) => `Meja ${t}: ${u[t] || 0}/${CAP}`).join(" &nbsp; ")}</p>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return J({ err: "Tidak ditemukan" }, 404);
};

export const config = { path: "/api/*" };
