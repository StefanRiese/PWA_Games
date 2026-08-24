# 🚽 Klo-App

**🔗 [Zur App](https://stefanriese.github.io/PWA_Games/)**

Ein schlanker Launcher für mehrere kleine Web-Apps/Spiele – optimiert für die Nutzung auf dem
Smartphone (iPhone und Android), ohne Installation aus dem App Store.

## Konzept

Diese Seite (`index.html`) ist die Startseite: eine Liste von Spielen, jedes davon eine eigene
Ein-Datei-App (kein Framework, kein Build-Schritt), genau wie dieses Shell selbst. Neue Spiele
werden als eigener Unterordner mit eigener `index.html` hinzugefügt und im `GAMES`-Array in dieser
Datei verlinkt. Gemeinsames CSS/JS (Design-Tokens, wiederkehrende Komponenten wie Schwierigkeits-
Auswahl oder Ergebnis-Banner, Theme-Übernahme vom Shell, Pinch-Zoom-Schutz) liegt in `shared/` und
wird von jedem Spiel eingebunden statt dupliziert – siehe unten.

## Features
- Übersicht aller Spiele als Kartenliste
- Dunkles / helles Theme (gespeichert)
- Offline-Nutzung dank Service Worker
- Als Web-App installierbar (Android/Chrome-Installationsdialog, iOS „Zum Home-Bildschirm")
- Automatische Update-Prüfung beim Öffnen (bei bestehender Internetverbindung)

## Ein neues Spiel hinzufügen
1. Unterordner mit eigener `index.html` anlegen (+ ggf. eigenes `manifest.json`/Icon, falls das
   Spiel auch einzeln installierbar sein soll)
2. `<link rel="stylesheet" href="../shared/common.css"/>` sowie
   `<script src="../shared/common.js"></script>` einbinden (siehe `CLAUDE.md`) – Design-Tokens,
   gemeinsame Komponenten-Styles sowie `loadShellPrefs()`/`applyTheme()`/Pinch-Zoom-Schutz kommen
   von dort und müssen nicht erneut implementiert werden
3. Einen Eintrag im `GAMES`-Array in `index.html` ergänzen und die Beschreibung in beiden
   `I18N`-Blöcken (`de`/`en`) hinzufügen:
   ```js
   { id: 'mein-spiel', emoji: '🎲', name: 'Mein Spiel', descKey: 'desc_mein_spiel', url: './mein-spiel/index.html' }
   ```
   `emoji` kann auch ein kleines Inline-SVG (statt eines echten Emojis) sein, wenn kein Emoji das
   Spiel gut trifft – siehe `CLAUDE.md` für Details.

## Deployment via GitHub Pages
1. Repository-Inhalt ins Repository-Root pushen
2. **Settings → Pages → Source:** „Deploy from a branch", Branch `main`, Ordner `/ (root)`
3. Nach kurzer Zeit erreichbar unter `https://<username>.github.io/<repository>`

## Technik
- Reines HTML, CSS und JavaScript – keine Frameworks, keine Build-Tools
- Gemeinsames CSS/JS für alle Spiele unter `shared/` (`common.css`/`common.js`), eingebunden per
  `<link>`/`<script src>` – weiterhin keine Build-Tools, nur ausgelagerte statische Dateien
- Offline-Support über einen Service Worker
- Web App Manifest (`manifest.json`) für die Installation auf Android/Chrome
- Theme-Einstellung über `localStorage`

## Lizenz
Privates Projekt – frei zur eigenen Nutzung und Anpassung.
