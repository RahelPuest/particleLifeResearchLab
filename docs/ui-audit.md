# UI-Audit – Particle Life

Stand: 30.09.2026. Untersuchung der laufenden Anwendung auf `http://127.0.0.1:5174/`. Es wurden keine Anwendungskomponenten geändert.

## Ergebnis

Die Oberfläche bietet einen funktionierenden, visuell konsistenten Simulationskern. Mit den zusätzlichen Funktionen ist die Seitenleiste aber zu einem langen Formular geworden. Besonders auf Mobilgeräten sind Einstellen und Beobachten voneinander getrennt. Die wichtigsten Korrekturen betreffen die Informationsarchitektur, unerwartete Zustandsänderungen und Eingabekonsistenz; ein weiteres Theme löst diese Probleme nicht.

16 priorisierte Befunde: 3 × P1, 11 × P2, 2 × P3. P1 bedeutet hohe Auswirkung auf einen zentralen Bedienablauf, P2 eine relevante Beeinträchtigung, P3 eine Verbesserung. Es wurde kein allgemeiner Start- oder Bedienungsblocker beobachtet.

## Umfang und Grenzen

- Direkt geprüft: Desktop 1440 × 1000 und 1440 × 900, Tabletbreite 768 × 1024, Mobilbreiten 390 × 844 und 320 × 740. Größen sind CSS-Viewportvorgaben, keine echten Mobilgeräte; die Browser-Scrollbar reduziert die verfügbare Inhaltsbreite.
- Alle drei Themes auf Desktop; Classic auf 320/390 px und Glass Light im mobilen Stoffwechselmodus. Glass Dark wurde mobil nicht separat visuell abgenommen.
- Classic und Metabolic, vier Darstellungsmodi und bedingte Einstellungen, Farbmodus Speed, Trails, Pause/Einzelschritt, Zoom, Matrixbearbeitung, Presets, Umwandlungsregeln, leere Regelliste, zufällige acht Regeln, ungültiger und gültiger JSON-Import, Tastaturbedienung einzelner Controls.
- Solveroberfläche: CPU Exact, Barnes–Hut, sampled CPU und metabolic GPU mesh, einschließlich der jeweils eingeblendeten Optionen. Der Stoffwechsel-Backendstatus meldete WebGPU. Kein neuer Leistungsvergleich und keine vollständige Wiederholung aller Solvertests.
- DOM, CSS und Handler wurden mit der sichtbaren Oberfläche abgeglichen. Die vorhandenen App-/Theme-Browsertests wurden gelesen, in diesem Audit aber nicht erneut ausgeführt.
- Kein vollständiger Screenreader-, Safari-, Firefox-, Touchhardware-, Browserzoom- oder WCAG-Konformitätstest. Transparenz-Fallbacks wurden im CSS geprüft, nicht über emulierte Systemeinstellungen ausgeführt.
- Im eingebetteten Browser führte der Vollbildklick zu keinem nachweisbaren Fullscreen-Zustand. Der Settings-Download erzeugte innerhalb von zehn Sekunden kein vom Werkzeug beobachtbares Download-Event. Beide Fälle sind **offene Host-/Browser-Verifikationen**, keine nachgewiesenen allgemeinen App-Defekte. PNG-Export und heruntergeladener Dateiinhalt wurden hier nicht erneut bestätigt.
- Keine Warnungen oder Fehler in den abgefragten Browserlogs während der geprüften Abläufe.

## Befunde

### U01 · P1 · Zentrale Steuerung verschwindet in einer sehr langen Seitenleiste

**Beleg:** Bei 1440 × 1000 beginnt die Matrix im Classic-Modus bei Dokument-y ≈ 1434 px. Mit acht Umwandlungsregeln liegt sie bei ≈ 3475 px; die Seite ist dann ≈ 4264 px hoch. Auf 390 px liegt die Matrix bei ≈ 1934 px beziehungsweise ≈ 3928 px; die Stoffwechselseite ist ≈ 4786 px hoch. Mobil ist das Feld nicht sticky. Beim Bearbeiten der Regeln sind weder Partikel noch Pause/Reset sichtbar.

**Auswirkung:** Der zentrale Ablauf „Parameter ändern → Wirkung beobachten → anhalten“ erfordert wiederholtes Scrollen. Aussehen und optionale Funktionen verdrängen die primären Simulationsregler.

**Empfehlung:** Desktop: kompakte Steuerung mit Bereichen „Simulation“, „Kräfte“, „Stoffwechsel“, „Darstellung“; Details gezielt aufklappen. Mobil: umschaltbare Ansicht Feld/Einstellungen mit ständig erreichbarer Transportleiste und optionaler kompakter Vorschau. Lange Regeln in einer eigenen Ansicht oder einklappbaren Liste.

**Abnahme:** Pause ist aus jedem Einstellbereich direkt erreichbar. Zwischen einer Kraftänderung und der Beobachtung ist kein langer Rückweg nötig. Acht Regeln verschieben nicht sämtliche anderen Funktionen um mehrere Bildschirmhöhen.

**Code:** `src/App.tsx:400`, `src/App.tsx:633`, `src/App.tsx:734`, `src/App.tsx:999`; `src/style.css:696`.

### U02 · P1 · Partikelzahl ist als Live-Regler dargestellt, setzt aber die Welt zurück

**Beleg:** Unter „LIVE CONTROLS“ ruft jede Änderung des Partikelzahlreglers unmittelbar `reset(c)` auf. Das gilt auch für einen Tastaturschritt von 1800 auf 1900. Der aktuelle Verlauf wird verworfen; beim Ziehen können mehrere Resets erfolgen. Ein Hinweis fehlt direkt am Regler.

**Empfehlung:** Wert zunächst bearbeiten, dann über „Mit neuer Partikelzahl starten“ anwenden; alternativ eindeutig als Neustart-Regler kennzeichnen und erst beim Abschluss der Änderung zurücksetzen. Zahlenfeld für präzise Eingaben ergänzen. Keine Bestätigungsdialoge bei jedem kleinen Schritt.

**Abnahme:** Der Nutzer erkennt die Neustartwirkung vor dem Auslösen; Ziehen erzeugt nicht für jeden Zwischenwert eine neue Welt.

**Code:** `src/App.tsx:892`.

### U03 · P1 · „Reset conversion rules“ verändert zusätzliche Einstellungen

**Beleg:** Conversion speed per Tastatur auf 1.1× und Initial mixing auf 5% gesetzt. Nach „Reset conversion rules“ stehen beide wieder auf 1.0× und 0%. Der Handler ersetzt das gesamte `metabolism`-Objekt.

**Empfehlung:** Nur `rules` zurücksetzen. Einen vollständigen Reset separat und eindeutig „Reset all metabolism settings“ benennen.

**Abnahme:** Ein Regelreset lässt Rate und Anfangsmischung unverändert.

**Code:** `src/App.tsx:612`.

### U04 · P2 · Mausrad scrollt die Seite und zoomt gleichzeitig

**Beleg:** Ein Scrollereignis über dem Feld änderte `scrollY` von 312 auf 562 und den Zoom von 100% auf 92%. `onWheel` setzt Zoom ohne Unterbindung des Seitenscrollens.

**Empfehlung:** Eine eindeutige Geste festlegen: beispielsweise normales Scrollen für die Seite, modifizierte Geste für Zoom; alternativ nur bei bewusst aktivierter Feldinteraktion das Rad konsumieren. Die Geste im Feld nennen und auf Trackpad testen.

**Abnahme:** Eine Scrollgeste führt nur eine der beiden Aktionen aus.

**Code:** `src/Viewport.tsx:265`.

### U05 · P2 · Appearance-Panel schrumpft auf Mobilgeräten

**Beleg:** Bei 390 px hat `aside` 339 px Breite, Appearance aber nur 201 px. Die anderen Panels füllen die Breite. `align-items: start` aus dem Tablet-Grid bleibt aktiv, wenn die mobile Seitenleiste zu Flex wechselt.

**Empfehlung:** Im schmalen Flexlayout `align-items: stretch` setzen oder Panels explizit auf volle verfügbare Breite bringen.

**Abnahme:** Bei 320 und 390 px sind alle Einstellpanels gleich breit, unabhängig vom ausgewählten Darstellungsmodus und erklärenden Zusatztext.

**Code:** `src/style.css:602`, `src/style.css:708`.

### U06 · P2 · Spezies haben verschiedene Identitäten in verschiedenen Bereichen

**Beleg:** Umwandlungsregeln verwenden A–D; Matrix und Editor verwenden Mint, Amber, Lilac, Rose. Die Matrixachsen zeigen nur farbige Punkte mit Hover-Titeln. Eine dauerhaft sichtbare Zuordnung A = Mint usw. fehlt ebenso wie eine Legende am Partikelfeld.

**Auswirkung:** Insbesondere beim Wechsel zwischen Stoffwechsel und Kräften muss die Zuordnung erraten werden. Farbe allein ist bei eingeschränkter Farbwahrnehmung und auf Touchgeräten problematisch.

**Empfehlung:** Einheitlich „A · Mint“ usw. in Regeln, Achsen und Legende verwenden. Bei gemischten Partikeln zusätzlich quantitative Anteile zugänglich machen.

**Abnahme:** Jede Spezies kann ohne Hover und ohne alleinige Farberkennung identifiziert werden.

**Code:** `src/App.tsx:96`, `src/App.tsx:525`, `src/App.tsx:1015`.

### U07 · P2 · Angezeigte Werte und Eingaberaster widersprechen sich

**Belege:**

- Trail persistence zeigt standardmäßig 57%, während das native Range-Element wegen `step=0.05` den Wert 0.55 führt. Ein Pfeiltastenschritt führt zu 60%.
- Standardreaktionen mit Rate 0.08 und 0.06 haben bei `step=0.05` schon direkt nach Reset `validity.stepMismatch === true`. Es ist kein blockierendes Formular vorhanden, dennoch sind die eigenen Standardwerte laut Eingabe ungültig.
- Randomize matrix erzeugt Near/Far-Werte in 0.01-Schritten, die Regler erlauben 0.05-Schritte. Der gleiche Konflikt kann daher auch bei zufälligen oder importierten Kraftwerten auftreten; dieser Teil ist durch Code belegt.

**Empfehlung:** Modell, Import, Anzeige und Eingabeschritt vereinheitlichen. Mindestens 0.01 für diese Werte zulassen oder Werte konsequent auf das gewünschte Raster normalisieren. Präzise Zahlenfelder neben Reglern ergänzen.

**Abnahme:** Alle Standard- und Zufallswerte sind in ihren Eingaben gültig; sichtbarer Wert und DOM-Wert stimmen überein.

**Code:** `src/visuals.ts:15`; `src/App.tsx:578`, `src/App.tsx:728`, `src/App.tsx:262`, `src/App.tsx:1086`.

### U08 · P2 · Auswählen einer Spezies ändert unbemerkt ein zweites Feld

**Beleg:** Neue Regel A → B. Quelle auf B ändern: Ziel springt automatisch auf C. Der Nutzer hat nur das Quellenfeld bearbeitet. Die Gegenrichtung wird analog automatisch geändert.

**Empfehlung:** Ungültige Kombinationen im jeweils anderen Select deaktivieren oder eine klare Inlinevalidierung mit expliziter Korrektur anbieten. Keine stille Änderung eines anderen fachlichen Parameters.

**Abnahme:** Eine Auswahl verändert nur den ausgewählten Parameter oder erklärt die notwendige gekoppelte Änderung sichtbar.

**Code:** `src/App.tsx:225`.

### U09 · P2 · Einige Classic-Texte unterschreiten den normalen Textkontrast

**Gemessen aus berechneten CSS-Farben auf opakem Hintergrund:**

| Element | Größe | Farben | Kontrast |
|---|---:|---|---:|
| „Drag to explore“ / Feldfooter | 9 px | #506b73 auf #081014 | 3.37:1 |
| „2D · Wrapping edges“ | 9 px | #4f6b73 auf #081014 | 3.36:1 |
| Seitenfooter-Grundtext | 10 px | #607c84 auf #0c1418 | 4.18:1 |

Für normalen Text gilt als WCAG-AA-Mindestwert 4.5:1; diese Texte sind nicht groß genug für die Ausnahme. [W3C: Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

**Empfehlung:** Kontraste anheben und funktionale Hilfstexte größer setzen. Badges mit 7 px und viele 9–10-px-Texte zusätzlich auf Lesbarkeit prüfen. Für die transparenten Glass-Hintergründe ist eine separate Prüfung der tatsächlich zusammengesetzten Farben nötig; hier wurde keine vollständige Kontrastfreigabe erteilt.

**Abnahme:** Die genannten Texte erreichen ≥ 4.5:1; Hilfstexte bleiben bei kleinen Displays gut lesbar.

**Code:** `src/style.css:224`, `src/style.css:262`, `src/style.css:450`.

### U10 · P2 · Kamera-Panning ist nur mit Ziehen möglich

**Beleg:** Der Interaktionscanvas besitzt weder `tabIndex` noch Tastaturhandler. Pan wird ausschließlich über Pointer-Drag geändert. Zoom und Reset haben dagegen bedienbare Buttons. Keyboardnavigation einzelner Controls und sichtbarer Fokus funktionieren.

**Empfehlung:** Fokusfähiger Simulationsbereich, beschriftete Pfeiltastensteuerung oder Pan-Buttons; klare Eingabehilfe. Semantische Beschreibung und eine kompakte textuelle Zustandszusammenfassung für das Feld ergänzen.

**Abnahme:** Kamera verschieben, zoomen und zurücksetzen ist ohne Maus möglich. Die Tastaturbedienung darf Formularfelder nicht beeinträchtigen. [W3C: Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html).

**Code:** `src/Viewport.tsx:243`.

### U11 · P2 · Mehrere Bedienelemente sind unnötig schwer zu treffen

**Beleg:** Matrix-Randomize misst 22 × 22 px, „New arrangement“ mobil nur 14 px Höhe. Die Range-Elemente sind mit 3 px Höhe gestaltet; ihre tatsächlichen nativen Thumb-/Label-Trefferflächen sind separat zu berücksichtigen. Checkboxen messen 13 × 13 px, haben aber klickbare Labels.

**Empfehlung:** Touchaktionen auf etwa 44 px komfortable Zielhöhe bringen, mindestens ausreichend große oder ausreichend getrennte Ziele. Die sichtbare Sliderlinie darf dünn bleiben, der interaktive Bereich sollte größer sein.

**Einordnung:** Kein pauschaler WCAG-Verstoß allein aus diesen Maßen: WCAG 2.5.8 berücksichtigt auch Abstände, äquivalente Controls und Ausnahmen. [W3C: Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).

**Code:** `src/style.css:374`, `src/style.css:385`, `src/style.css:619`.

### U12 · P2 · Experimentieren bietet keinen Rückweg

**Beleg:** Matrix-Randomize, Rule-Randomize, Presetwechsel und Remove überschreiben unmittelbar. Es gibt weder Undo noch eine Regelhistorie. Der Markenlink navigiert außerdem zu `./`, wodurch ein nicht exportierter Versuch verloren gehen kann. Einstellungen werden initial aus DEFAULT geladen.

**Empfehlung:** Mindestens Undo für Regeln/Matrix und Wiederherstellung der letzten Konfiguration. Die Marke auf dieser Einseitenanwendung nicht als unbeabsichtigten Reset benutzen. Seed editierbar machen und Neustart von Zurücksetzen der Regeln unterscheiden.

**Abnahme:** Eine versehentlich entfernte oder randomisierte Konfiguration lässt sich mit einem Schritt wiederherstellen.

**Code:** `src/App.tsx:109`, `src/App.tsx:252`, `src/App.tsx:257`, `src/App.tsx:296`, `src/App.tsx:484`, `src/App.tsx:506`.

### U13 · P2 · Backend-Auswahl verlangt zu früh Implementierungswissen

**Beleg:** Zehn Solveroptionen stehen gleichrangig im zentralen Formular. „Automatic exact“ wählt ausschließlich zwischen GPU-Verfahren; das Label erklärt diesen Umfang nicht. CPU-Optionen sind nicht alle ausdrücklich als CPU bezeichnet. Im Stoffwechselmodus bleiben acht nicht verfügbare Optionen im Menü.

**Empfehlung:** Einfache Auswahl nach Zweck: „Exakt“, „Viele Partikel / Näherung“, „Erweitert“. Algorithmusnamen und Tuningoptionen in Erweitert. Automatik eindeutig als GPU-Automatik benennen; angefordertes und tatsächlich aktives Backend bei Fallback unterscheiden. Nicht verfügbare Optionen mit unmittelbar zuordenbarer Begründung versehen.

**Abnahme:** Ohne BVH-/FFT-/Barnes–Hut-Vorkenntnisse ist erkennbar, welche Auswahl exakt oder approximativ ist und ob CPU oder GPU tatsächlich rechnet.

**Code:** `src/App.tsx:758`, `src/App.tsx:860`.

### U14 · P2 · Wichtige Zustände sind visuell nicht messbar

**Belege:** Die Anzeige rundet Simulationszeit auf eine Dezimalstelle. Die ersten zwei einzeln ausgelösten Schritte nach Reset zeigen weiterhin 0.0s. Speed-Färbung erklärt nur „Blue → amber“, ohne numerische Farbskala. Für metabolische Mischungen existieren keine Anteil-Anzeige, Populationsstatistik oder Partikelinspektion.

**Empfehlung:** Schrittzähler oder feinere Zeitdarstellung beim Pausieren. Numerische Speed-Legende und Populationsanteile je Spezies; optional Klickinspektor für ein Partikel. Renderleistung und Simulationsdurchsatz klar getrennt halten.

**Abnahme:** Jeder Einzelschritt hat eine sichtbare Zustandsrückmeldung. Eine Mischungs- oder Geschwindigkeitsfarbe kann quantitativ interpretiert werden.

**Code:** `src/App.tsx:380`, `src/App.tsx:671`; `src/Viewport.tsx:243`.

### U15 · P3 · Zusammengehörige Aktionen liegen weit auseinander

**Beleg:** Motion trails sitzt am Feld, Trail persistence im Appearance-Panel. Save settings steht ganz oben, Load settings im Seitenfooter. Bei langen Stoffwechselregeln liegen mehrere Bildschirmhöhen zwischen zusammengehörigen Funktionen. Speichern exportiert die Konfiguration mit Seed, keinen fortsetzbaren Snapshot der laufenden Welt; diese Grenze wird im UI nicht erklärt.

**Empfehlung:** Trails und Persistenz zusammenführen; gemeinsames Settings-Menü mit Import/Export. Export ausdrücklich als Konfiguration kennzeichnen und die Neustartwirkung beim Import nennen. Eine Statusmeldung nach erfolgreichem Import ergänzen.

**Abnahme:** Zusammengehörige Aktionen sind an einem Ort, und Export/Import wecken keine Erwartung einer exakten Wiederaufnahme der aktuellen Welt.

**Code:** `src/App.tsx:98`, `src/App.tsx:279`, `src/App.tsx:382`, `src/App.tsx:716`, `src/App.tsx:1120`.

### U16 · P3 · Leere und besondere Zustände sind zu knapp erklärt

**Beleg:** Nach Entfernen sämtlicher Regeln verschwindet die Liste ohne Erklärung, dass nun keine Umwandlung stattfindet. Bei acht Regeln wird Add deaktiviert, ohne direkt dort das Limit zu nennen. Ungültiger Import zeigt „Invalid count.“ als korrekt auslösbaren und schließbaren Alert, jedoch ohne erlaubten Wertebereich. Es fehlt ein `h1`; die erste Dokumentüberschrift ist ein Einstellpanel.

**Empfehlung:** Kurze, zustandsabhängige Hinweise: „Keine Umwandlung aktiv“, „8 von 8 Regeln“, konkrete Importfehler mit Erwartungswerten. Ein zugänglicher Seitentitel kann kompakt oder visuell verborgen sein; die entfernte große Introspalte muss dafür nicht zurückkommen.

**Abnahme:** Leere/deaktivierte Zustände erklären Ursache und nächste Handlung, Fehler sagen wie sie behoben werden können.

**Code:** `src/App.tsx:499`, `src/App.tsx:594`, `src/App.tsx:1142`; `src/engine/simulation.ts:236`.

## Was bereits gut funktioniert

- Das Partikelfeld hat auf Desktop Vorrang und bleibt beim Scrollen der Seite sichtbar.
- Alle drei Themes wirken zusammengehörig; das dunkle Feld behält auch im hellen Theme seinen Kontrast.
- Kein horizontaler Dokumentüberlauf bei den geprüften Breiten 320, 390 und 768 px.
- Iconbuttons haben zugängliche Namen; Matrixauswahl besitzt `aria-pressed`, relevante Eingaben Labels. Native Controls lassen sich per Tastatur bedienen, der sichtbare Fokus ist vorhanden.
- Modewechsel und Anfangsmischung haben erklärende Hinweise; Approximationen und Light-field-Helligkeit werden ausdrücklich als solche eingeordnet.
- Bedingte Regler für Intensität, Sampling und Öffnungswinkel erscheinen passend. Trail persistence wird ohne aktive Trails deaktiviert.
- Regelbearbeitung, Matrixauswahl und Kraftaktionen funktionieren. Ungültiger Import erzeugt einen Alert; ein anschließender gültiger Import stellt die Konfiguration wieder her und beseitigt den Fehler.
- Laufend aktualisierte Performancemetriken sind mit `aria-live="off"` versehen. Kein Anlass, hier pauschal Screenreader-Daueransagen zu behaupten.

## Empfohlene Umsetzung

1. **Korrektheit und überraschende Aktionen:** U02–U04, U07, U08. Kleine, klar prüfbare Verhaltenskorrekturen vor einem größeren Umbau.
2. **Layout und Orientierung:** U01, U05, U06, U15. Panelhierarchie, mobiler Beobachtungsfluss und einheitliche Speziesidentität gemeinsam gestalten.
3. **Zugänglichkeit und Messbarkeit:** U09–U11, U14, U16. Kontraste, Kamera mit Tastatur, Trefferflächen, Legenden und klare Rückmeldungen.
4. **Experimentierkomfort:** U12, U13. Undo, Wiederherstellung und verständliche Solverauswahl.

Vollbild zusätzlich in einem regulären Browser verifizieren: Der Code setzt nur `.viewport` in Vollbild, die Transportbuttons liegen außerhalb. Falls echtes Vollbild funktioniert, sind Pause und Einzelschritt dort folglich nicht enthalten. Beides in den Vollbildbereich integrieren und den Buttonzustand als „Exit fullscreen“ wiedergeben. Diese Aussage ist eine Codeanalyse, kein erfolgreich abgeschlossener Vollbildtest.

## Belege

Screenshots befinden sich in `reports/ui-audit/`:

- `desktop-classic.png`, `desktop-glass-dark.png`, `desktop-glass-light.png`
- `mobile-classic.png`, `mobile-320.png`, `tablet-768.png`
- `mobile-panel-width.png` – reproduzierbarer Breitenfehler
- `metabolic-desktop-full.png`, `metabolic-mobile-rules.png` – Umfang mit acht Regeln
- `mobile-matrix.png`, `mobile-panels-full.png`
- `mobile-import-error.png`, `empty-rules-mobile.png`
- `fullscreen-attempt.png` – Versuch, **kein** erfolgreicher Fullscreen-Beleg

Testdateien: `default-settings.json` und `invalid-settings.json`. Die originale weiterentwickelte Partikelanordnung wurde durch die erforderlichen Neustarttests verändert; am Ende wurden Standardkonfiguration, Classic-Theme und laufender Zustand wiederhergestellt. Die temporäre Viewportvorgabe wurde entfernt.
