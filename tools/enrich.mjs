#!/usr/bin/env node
// Import-Script: tools/entries.json -> DATA + DETAILS in index.html
//
// Aufruf (aus dem Projektordner):
//   node tools/enrich.mjs                      schreibt nach index.html
//   node tools/enrich.mjs --target pfad.html   schreibt in eine andere Kopie (z.B. zum Testen)
//   node tools/enrich.mjs --no-date            "Stand:" im Header nicht anfassen
//   Zusätzlich möglich: --entries datei.json, --cache datei.json, --drive-cache datei.json, --failures datei.json
//
// Pro Eintrag:
//   0. Hat der Eintrag lat und lon (z.B. aus Google Maps), wird kein Geocoding gemacht.
//   1. Sonst Geocoding per Nominatim (OpenStreetMap), 1 Anfrage pro Sekunde, Land aus der Adresse abgeleitet.
//      Läuft Nominatim in Limits, springt das Script auf Photon (ebenfalls OpenStreetMap) um.
//   2. Fahrstrecke und Fahrzeit ab Schwabach per OSRM. Gibt es keine Straßenroute (Inseln, Übersee),
//      bleiben Fahrstrecke und Fahrzeit leer, die Luftlinie wird trotzdem berechnet.
// Fehlschläge brechen den Lauf nicht ab: der Eintrag kommt ohne Koordinaten in die Karte und steht in der Fehlerliste.
// Ergebnisse von Geocoding und Route werden zwischengespeichert, ein erneuter Lauf ist schnell.
// Bereits vorhandene Einträge in index.html bleiben erhalten, neue werden per Name ergänzt oder aktualisiert.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const TARGET = path.resolve(argVal('--target') || path.join(ROOT, 'index.html'));
const SKIP_DATE = args.includes('--no-date');
const ENTRIES = path.resolve(argVal('--entries') || path.join(ROOT, 'tools', 'entries.json'));
const CACHE = path.resolve(argVal('--cache') || path.join(ROOT, 'tools', 'geo-cache.json'));
const DRIVE_CACHE = path.resolve(argVal('--drive-cache') || path.join(ROOT, 'tools', 'drive-cache.json'));
const FAILURES = path.resolve(argVal('--failures') || path.join(ROOT, 'tools', 'enrich-failures.json'));

const SCHWABACH = { lat: 49.3346915, lon: 11.0294139 };
const UA = 'erwachsenen-ausflugsziele-karte/1.0 (private hobby project; https://github.com/cbayer76/erwachsenen-ausflugsziele-karte)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const cache = readJson(CACHE, {});
const driveCache = readJson(DRIVE_CACHE, {});
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2) + '\n');
const saveDriveCache = () => fs.writeFileSync(DRIVE_CACHE, JSON.stringify(driveCache, null, 2) + '\n');

// Länderwort am Ende der Adresse -> ISO-Code
const COUNTRY_CODES = {
  'deutschland': 'de', 'österreich': 'at', 'tschechien': 'cz', 'česko': 'cz', 'niederlande': 'nl', 'italien': 'it',
  'schweiz': 'ch', 'frankreich': 'fr', 'lettland': 'lv', 'polen': 'pl', 'rumänien': 'ro', 'spanien': 'es',
  'ungarn': 'hu', 'irland': 'ie', 'ukraine': 'ua', 'belgien': 'be', 'portugal': 'pt', 'litauen': 'lt',
  'türkei': 'tr', 'slowakei': 'sk', 'kroatien': 'hr', 'slowenien': 'si', 'dänemark': 'dk', 'luxemburg': 'lu',
  'großbritannien': 'gb', 'vereinigtes königreich': 'gb', 'griechenland': 'gr', 'estland': 'ee', 'schweden': 'se',
  'norwegen': 'no', 'finnland': 'fi', 'bulgarien': 'bg', 'serbien': 'rs', 'montenegro': 'me', 'albanien': 'al',
  'bosnien und herzegowina': 'ba', 'malta': 'mt', 'zypern': 'cy', 'island': 'is', 'liechtenstein': 'li'
};
function countryOf(addr) {
  const tail = (addr.split(',').pop() || '').trim().toLowerCase();
  return COUNTRY_CODES[tail] || null;
}

function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// HTTP mit Wartezeit und Wiederholung bei Limits (429) und Serverfehlern
async function getJson(url, headers = {}, tries = 5) {
  let lastErr;
  for (let t = 1; t <= tries; t++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
      if (res.status === 429 || res.status >= 500) { lastErr = new Error('HTTP ' + res.status); await sleep(15000 * t); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (/^HTTP 4/.test(e.message)) throw e;
      await sleep(5000 * t);
    }
  }
  throw lastErr;
}

let lastNominatim = 0;
async function nominatim(params, cc) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const q = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '3', ...(cc ? { countrycodes: cc } : {}), ...params });
  return getJson('https://nominatim.openstreetmap.org/search?' + q, { 'Accept-Language': 'de' }, 3);
}
let lastPhoton = 0;
async function photon(qtext) {
  const wait = 600 - (Date.now() - lastPhoton);
  if (wait > 0) await sleep(wait);
  lastPhoton = Date.now();
  const j = await getJson('https://photon.komoot.io/api/?' + new URLSearchParams({ q: qtext, limit: '3', lang: 'de' }), {}, 3);
  return (j.features || []).map(f => ({
    lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
    address: { postcode: f.properties.postcode, house_number: f.properties.housenumber },
    display_name: [f.properties.name, f.properties.street, f.properties.city, f.properties.country].filter(Boolean).join(', ')
  }));
}

const normPlz = s => String(s || '').replace(/\s+/g, '');
// "Straße Nr, PLZ Ort[, Land]" zerlegen; PLZ darf 4 bis 5 Ziffern haben, auch mit Leerzeichen (101 00)
function splitAddr(addr) {
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(/^(\d{3}\s?\d{2}|\d{4,5})\s+(.+)$/);
    if (m) return { street: parts.slice(0, i).join(', '), plz: normPlz(m[1]), city: m[2] };
  }
  return { street: '', plz: null, city: '' };
}

// Stadt aus der Adresse raten (vorletzter Teil, ohne Klammern und PLZ)
function cityGuess(addr) {
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let c = parts[parts.length - 2].replace(/\(.*?\)/g, '').replace(/\b\d{3}\s?\d{2}\b/, '').replace(/\b\d{4,5}\b/, '').trim();
  return c || null;
}
const countryName = addr => (addr.split(',').pop() || '').trim();
// Mittelpunkt der Stadt, gemerkt im Cache. Dient nur als Plausibilitätsprüfung und als letzter Ausweg.
async function cityCenter(e) {
  const c = cityGuess(e.addr);
  if (!c) return null;
  const cc = countryOf(e.addr);
  const key = 'CITY|' + (cc || '') + '|' + c;
  if (cache[key]) return cache[key].fail ? null : cache[key];
  let hit = null;
  try { const r = await nominatim({ q: `${c}, ${countryName(e.addr)}` }, cc); hit = r && r[0]; } catch { /* kein Zentrum */ }
  if (!hit) { try { const r = await photon(`${c}, ${countryName(e.addr)}`); hit = r[0]; } catch { /* kein Zentrum */ } }
  cache[key] = hit ? { lat: +(+hit.lat).toFixed(6), lon: +(+hit.lon).toFixed(6) } : { fail: true };
  saveCache();
  return hit ? cache[key] : null;
}
const MAX_KM_FROM_CITY = 60;
async function plausible(e, hit) {
  const c = await cityCenter(e);
  if (!c) return true; // ohne Zentrum keine Prüfung möglich
  return haversineKm(c, { lat: +hit.lat, lon: +hit.lon }) <= MAX_KM_FROM_CITY;
}

async function geocode(e) {
  const key = e.addr + '|' + e.name;
  if (cache[key] && !cache[key].fail) return cache[key];
  const cc = countryOf(e.addr);
  const { street, plz, city } = splitAddr(e.addr);
  let hit = null, approx = false;
  const tryNominatim = async (params) => { try { return await nominatim(params, cc); } catch { return null; } };

  // 1. strukturierte Suche (nur bei erkennbarer Adresse mit Straße)
  if (street && city) {
    const rows = await tryNominatim({ street, ...(plz ? { postalcode: plz } : {}), city });
    if (rows) {
      hit = rows.find(r => !plz || normPlz(r.address && r.address.postcode) === plz) || null;
      if (hit && !(hit.address && hit.address.house_number) && /\d/.test(street)) approx = true;
    }
    // ohne Hausnummer
    if (!hit && rows && /\d+\s*[a-z]?(\/\d+)?$/i.test(street)) {
      const r2 = await tryNominatim({ street: street.replace(/\s+\d+\s*[a-z]?(\/\d+)?$/i, ''), ...(plz ? { postalcode: plz } : {}), city });
      hit = (r2 && r2[0]) || null;
      if (hit) approx = true;
    }
  }
  // 2. freie Suche mit voller Adresse, dann mit Name und Adresse
  if (!hit) {
    const r = await tryNominatim({ q: e.addr });
    hit = (r && r[0]) || null;
    if (hit && !street) approx = true;
    if (hit && street) approx = approx || !(hit.address && hit.address.house_number);
  }
  if (!hit) {
    const r = await tryNominatim({ q: `${e.name}, ${e.addr}` });
    hit = (r && r[0]) || null;
    if (hit) approx = true;
  }
  // 3. Photon als zweite Quelle, falls Nominatim nichts liefert (oder gesperrt ist)
  if (!hit) {
    for (const q of [`${e.name}, ${e.addr}`, e.addr]) {
      try { const r = await photon(q); if (r[0]) { hit = r[0]; approx = true; break; } } catch { /* nächste Abfrage */ }
    }
  }
  // Treffer, die weit von der genannten Stadt liegen, verwerfen und es mit den anderen Abfragen erneut versuchen
  if (hit && !(await plausible(e, hit))) {
    hit = null;
    for (const q of [`${e.name}, ${cityGuess(e.addr) || ''}, ${countryName(e.addr)}`, `${e.name}, ${e.addr}`]) {
      try {
        const r = await nominatim({ q }, cc);
        const h = (r || []).find(x => true);
        if (h && await plausible(e, h)) { hit = h; approx = true; break; }
      } catch { /* nächste Abfrage */ }
    }
  }
  if (!hit) {
    // letzter Ausweg: Mitte der Stadt, deutlich als ungefähr markiert
    const c = await cityCenter(e);
    if (c) { hit = { lat: c.lat, lon: c.lon, display_name: 'Stadtmitte (Adresse nicht auffindbar)' }; approx = true; }
  }
  if (!hit) throw new Error('Kein Geocoding-Treffer für ' + e.name + ' (' + e.addr + ')');

  const out = { lat: +(+hit.lat).toFixed(6), lon: +(+hit.lon).toFixed(6), approx, osm: hit.display_name };
  cache[key] = out;
  saveCache();
  return out;
}

let lastOsrm = 0;
async function drive(lat, lon) {
  const key = lat + ',' + lon;
  if (driveCache[key]) return driveCache[key].noRoute ? { driveKm: null, driveMin: null } : driveCache[key];
  const wait = 300 - (Date.now() - lastOsrm);
  if (wait > 0) await sleep(wait);
  lastOsrm = Date.now();
  let j;
  try {
    j = await getJson(`https://router.project-osrm.org/route/v1/driving/${SCHWABACH.lon},${SCHWABACH.lat};${lon},${lat}?overview=false`, {}, 4);
  } catch (e) {
    // "NoRoute" kommt vom Server als HTTP 400: dann gibt es wirklich keine Straßenroute
    if (/^HTTP 400/.test(e.message)) { driveCache[key] = { noRoute: true }; saveDriveCache(); return { driveKm: null, driveMin: null }; }
    throw e;
  }
  if (j.code === 'NoRoute' || j.code === 'NoSegment' || !j.routes?.length) {
    driveCache[key] = { noRoute: true }; saveDriveCache();
    return { driveKm: null, driveMin: null };
  }
  const r = { driveKm: +(j.routes[0].distance / 1000).toFixed(1), driveMin: Math.round(j.routes[0].duration / 60) };
  driveCache[key] = r; saveDriveCache();
  return r;
}

// Block zwischen /*X_START*/ ... /*X_END*/ lesen und ersetzen
function blockRange(html, tag) {
  const a = html.indexOf(`/*${tag}_START*/`), b = html.indexOf(`/*${tag}_END*/`);
  if (a < 0 || b < 0 || b < a) throw new Error(`Marker ${tag} nicht gefunden in ${TARGET}`);
  return [a, b + `/*${tag}_END*/`.length];
}
function readBlock(html, tag, varName, empty) {
  const [a, b] = blockRange(html, tag);
  const inner = html.slice(a + `/*${tag}_START*/`.length, b - `/*${tag}_END*/`.length).trim();
  const m = inner.match(new RegExp(`^const ${varName}\\s*=\\s*([\\s\\S]*?);?$`));
  try { return JSON.parse(m[1]); } catch { return empty; }
}
function writeBlock(html, tag, varName, value) {
  const [a, b] = blockRange(html, tag);
  return html.slice(0, a) + `/*${tag}_START*/const ${varName} = ${JSON.stringify(value)};/*${tag}_END*/` + html.slice(b);
}

const entries = readJson(ENTRIES, null);
if (!Array.isArray(entries) || !entries.length) { console.error('tools/entries.json fehlt oder ist leer'); process.exit(1); }

let html = fs.readFileSync(TARGET, 'utf8');
const data = readBlock(html, 'DATA', 'DATA', []);
const details = readBlock(html, 'DETAILS', 'DETAILS', {});
const failures = [];

let n = 0;
for (const e of entries) {
  n++;
  process.stdout.write(`[${n}/${entries.length}] ${e.name} … `);
  const addrFull = /deutschland|österreich|česko|tschechien|nederland|niederlande|italia|italien|schweiz|france|frankreich|latvija|lettland|polen|rumänien|spanien|ungarn|irland|ukraine|belgien|portugal|litauen|türkei|slowakei|kroatien|slowenien|dänemark|luxemburg|großbritannien|griechenland/i.test(e.addr) ? e.addr : e.addr + ', Deutschland';
  let lat = null, lon = null, approx = !!e.approx, dk = null, dm = null, distanceKm = null, err = null;
  try {
    if (typeof e.lat === 'number' && typeof e.lon === 'number') { lat = +e.lat.toFixed(6); lon = +e.lon.toFixed(6); }
    else { const g = await geocode(e); lat = g.lat; lon = g.lon; approx = approx || g.approx; }
    distanceKm = +haversineKm(SCHWABACH, { lat, lon }).toFixed(1);
    try { const d = await drive(lat, lon); dk = d.driveKm; dm = d.driveMin; }
    catch (ex) { err = 'Route: ' + ex.message; }
  } catch (ex) { err = ex.message; }
  if (err) failures.push({ name: e.name, addr: e.addr, fehler: err });
  const row = {
    name: e.name, type: e.type, group: e.group,
    rating: e.rating ?? null, reviews: e.reviews ?? null,
    note: e.note || '',
    lat, lon, distanceKm,
    approx: lat == null ? true : approx,
    addr: addrFull,
    driveKm: dk, driveMin: dm
  };
  const i = data.findIndex(x => x.name === e.name);
  if (i >= 0) data[i] = row; else data.push(row);
  if (e.details) details[e.name] = e.details;
  console.log(lat == null ? 'KEIN STANDORT' : `${lat}, ${lon}${row.approx ? ' (ungefähr)' : ''} · ${dk == null ? 'keine Route' : dk + ' km · ' + dm + ' Min'}${err ? ' · ' + err : ''}`);
}

html = writeBlock(html, 'DATA', 'DATA', data);
html = writeBlock(html, 'DETAILS', 'DETAILS', details);
if (!SKIP_DATE) {
  const t = new Date();
  const stand = `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.${t.getFullYear()}`;
  html = html.replace(/Stand: \d{2}\.\d{2}\.\d{4}/, 'Stand: ' + stand);
}
fs.writeFileSync(TARGET, html);
fs.writeFileSync(FAILURES, JSON.stringify(failures, null, 2) + '\n');
console.log(`\n${data.length} Einträge in ${path.basename(TARGET)} geschrieben. Fehlschläge: ${failures.length}${failures.length ? ' (siehe ' + path.basename(FAILURES) + ')' : ''}.`);
