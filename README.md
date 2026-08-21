# 🎮 PWA Games

**🔗 [Zur App](https://stefanriese.github.io/PWA_Games/)**

Ein schlanker Launcher für mehrere kleine Web-Apps/Spiele – optimiert für die Nutzung auf dem
Smartphone (iPhone und Android), ohne Installation aus dem App Store.

## Konzept

Diese Seite (`index.html`) ist die Startseite: eine Liste von Spielen, jedes davon eine eigene,
in sich geschlossene Ein-Datei-App (kein Framework, kein Build-Schritt), genau wie dieses Shell
selbst. Neue Spiele werden als eigener Unterordner mit eigener `index.html` hinzugefügt und im
`GAMES`-Array in dieser Datei verlinkt.

## Features
- Übersicht aller Spiele als Kartenliste
- Dunkles / helles Theme (gespeichert)
- Offline-Nutzung dank Service Worker
- Als Web-App installierbar (Android/Chrome-Installationsdialog, iOS „Zum Home-Bildschirm")
- Automatische Update-Prüfung beim Öffnen (bei bestehender Internetverbindung)

## Ein neues Spiel hinzufügen
1. Unterordner mit eigener `index.html` (+ ggf. `manifest.json`/Icon) anlegen
2. Einen Eintrag im `GAMES`-Array in `index.html` ergänzen:
   ```js
   { id: 'mein-spiel', emoji: '🎲', name: 'Mein Spiel', desc: 'Kurzbeschreibung', url: './mein-spiel/index.html' }
   ```

## Deployment via GitHub Pages
1. Repository-Inhalt ins Repository-Root pushen
2. **Settings → Pages → Source:** „Deploy from a branch", Branch `main`, Ordner `/ (root)`
3. Nach kurzer Zeit erreichbar unter `https://<username>.github.io/<repository>`

## Technik
- Reines HTML, CSS und JavaScript – keine Frameworks, keine Build-Tools
- Offline-Support über einen Service Worker
- Web App Manifest (`manifest.json`) für die Installation auf Android/Chrome
- Theme-Einstellung über `localStorage`

## Lizenz
Privates Projekt – frei zur eigenen Nutzung und Anpassung.
