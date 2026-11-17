# Karten verbinden (A + C) und Donautherme Ingolstadt – 17.11.2026

## Auftrag
- **A:** Umschalter „Kinder | Erwachsene" in der Kopfzeile beider Karten.
- **C:** Schalter im Filterbereich, der die Orte der anderen Karte blass auf der Karte einblendet (nur Karte, nicht Liste; immer alle Orte). Popup mit Kategorie, Fahrzeit, „Zur Rundtour" und Link in die andere Karte. Daten werden live von der anderen GitHub-Pages-Seite gelesen.
- Neuer Eintrag **Donautherme Ingolstadt** (Kinderkarte: Schwimmbäder, Erwachsenenkarte: Wellness & Therme), Werte von donautherme.de.

## Bilder
- `*-vorher.png` / `*-nachher.png`: gleicher Ausschnitt, gleiches Format (1280×800 Desktop, 375×812 Mobil), gleicher Zustand.
  - `start-*`: Startansicht nach dem Entsperren.
  - `therme-*`: Filter Schwimmbäder bzw. Wellness & Therme, sortiert nach Fahrzeit.
- `vergleich-*.png`: Vorher und Nachher nebeneinander.
- `einblenden-*-neu.png`: neue Funktion C eingeschaltet, kein Vorher-Bild (Funktion gab es nicht).

## Erklärte Unterschiede
- Kopfzeile: Umschalter neben dem Titel; der Text rechts davon rückt nach rechts.
- Filterzeile: neuer Schalter, die Zeile wird 2–3 px höher, Karte und Liste beginnen entsprechend tiefer.
- Mobil: Der Umschalter passt nicht neben den langen Titel und steht in einer eigenen Zeile darunter (ca. 22 px mehr Kopfhöhe, Karte entsprechend kleiner).
- Ortszahl +1 und neuer Marker/Listeneintrag durch die Donautherme.
- Erwachsenenkarte: „Stand" springt auf 17.11.2026 (setzt das Import-Script tools/enrich.mjs bei jedem Lauf).
- Kinderkarte: enthält zusätzlich die bereits freigegebene Ansichtsauswahl „Karte + Liste / Nur Liste / Tabelle" (war lokal, nicht gepusht; im Vorher-Bild schon sichtbar).
