#!/usr/bin/env node
// Import-Script: tools/entries.json -> DATA + DETAILS in index.html
//
// Aufruf (aus dem Projektordner):
//   node tools/enrich.mjs                      schreibt nach index.html
//   node tools/enrich.mjs --target pfad.html   schreibt in eine andere Kopie (z.B. zum Testen)
//   node tools/enrich.mjs --no-date            "Stand:" im Header nicht anfassen
//   Zusätzlich möglich: --entries datei.json und --cache datei.json für Testläufe
//
// Pro Eintrag ohne Koordinaten:
//   1. Geocoding per Nominatim (OpenStreetMap), 1 Anfrage pro Sekunde, Ergebnis wird in tools/geo-cache.json gemerkt
//   2. Fahrstrecke und Fahrzeit ab Schwabach per OSRM, Luftlinie per Haversine
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

const SCHWABACH = { lat: 49.3346915, lon: 11.0294139 };
const UA = 'erwachsenen-ausflugsziele-karte/1.0 (private hobby project; https://github.com/cbayer76/erwachsenen-ausflugsziele-karte)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const cache = readJson(CACHE, {});

function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let lastNominatim = 0;
async function nominatim(params) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '3', countrycodes: 'de,at,cz,nl,it,ch,fr,lv', ...params });
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' } });
  if (!res.ok) throw new Error('Nominatim ' + res.status);
  return res.json();
}

// Adresse "Straße Nr, PLZ Ort" zerlegen
function splitAddr(addr) {
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  const street = parts[0] || '';
  const m = (parts[1] || '').match(/^(\d{4,5})\s+(.+)$/);
  return { street, plz: m ? m[1] : null, city: m ? m[2] : (parts[1] || '') };
}

async function geocode(e) {
  const key = e.addr + '|' + e.name;
  if (cache[key]) return cache[key];
  const { street, plz, city } = splitAddr(e.addr);
  let hit = null, approx = false;

  // 1. strukturierte Suche mit Straße, PLZ, Ort
  let rows = await nominatim({ street, ...(plz ? { postalcode: plz } : {}), city });
  hit = rows.find(r => !plz || (r.address && r.address.postcode === plz)) || null;
  if (hit && !(hit.address && hit.address.house_number) && /\d/.test(street)) approx = true; // Hausnummer nicht gefunden: nur Straße

  // 2. ohne Hausnummer
  if (!hit && /\d+\s*[a-z]?$/i.test(street)) {
    rows = await nominatim({ street: street.replace(/\s+\d+\s*[a-z]?$/i, ''), ...(plz ? { postalcode: plz } : {}), city });
    hit = rows[0] || null;
    if (hit) approx = true;
  }
  // 3. freie Suche nach Name und Ort
  if (!hit) {
    rows = await nominatim({ q: `${e.name}, ${city}` });
    hit = rows[0] || null;
    if (hit) approx = true;
  }
  if (!hit) throw new Error('Kein Geocoding-Treffer für ' + e.name + ' (' + e.addr + ')');

  const out = { lat: +(+hit.lat).toFixed(6), lon: +(+hit.lon).toFixed(6), approx, osm: hit.display_name };
  cache[key] = out;
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2) + '\n');
  return out;
}

async function drive(lat, lon) {
  const url = `https://router.project-osrm.org/route/v1/driving/${SCHWABACH.lon},${SCHWABACH.lat};${lon},${lat}?overview=false`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('OSRM ' + res.status);
  const j = await res.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error('OSRM ohne Route');
  return { driveKm: +(j.routes[0].distance / 1000).toFixed(1), driveMin: Math.round(j.routes[0].duration / 60) };
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

for (const e of entries) {
  process.stdout.write(`• ${e.name} … `);
  const addrFull = /deutschland|österreich|česko|nederland|italia|schweiz|france|latvija/i.test(e.addr) ? e.addr : e.addr + ', Deutschland';
  const g = await geocode(e);
  const d = await drive(g.lat, g.lon);
  const row = {
    name: e.name, type: e.type, group: e.group,
    rating: e.rating ?? null, reviews: e.reviews ?? null,
    note: e.note || '',
    lat: g.lat, lon: g.lon,
    distanceKm: +haversineKm(SCHWABACH, g).toFixed(1),
    approx: !!(e.approx || g.approx),
    addr: addrFull,
    driveKm: d.driveKm, driveMin: d.driveMin
  };
  const i = data.findIndex(x => x.name === e.name);
  if (i >= 0) data[i] = row; else data.push(row);
  if (e.details) details[e.name] = e.details;
  console.log(`${g.lat}, ${g.lon}${row.approx ? ' (ungefähr)' : ''} · ${d.driveKm} km · ${d.driveMin} Min`);
}

html = writeBlock(html, 'DATA', 'DATA', data);
html = writeBlock(html, 'DETAILS', 'DETAILS', details);
if (!SKIP_DATE) {
  const t = new Date();
  const stand = `${String(t.getDate()).padStart(2, '0')}.${String(t.getMonth() + 1).padStart(2, '0')}.${t.getFullYear()}`;
  html = html.replace(/Stand: \d{2}\.\d{2}\.\d{4}/, 'Stand: ' + stand);
}
fs.writeFileSync(TARGET, html);
console.log(`\n${data.length} Einträge in ${path.basename(TARGET)} geschrieben.`);
