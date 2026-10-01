# SexySelectie

TicketSwap × Tinder: je logt in, scant je ticket en ziet daarna **alleen mensen die naar hetzelfde festival of feest gaan als jij**. Swipe naar rechts, en bij een wederzijdse like opent er een chat.

## Snel starten

Vereist Node.js 22.5 of nieuwer (gebruikt de ingebouwde `node:sqlite`).

```bash
npm install
npm run seed     # demo-evenementen, demo-profielen en ticketcodes
npm start        # http://localhost:3000
```

1. Maak een account aan (18+).
2. Ga naar **Tickets** en voer een van de ticketcodes in die `npm run seed` print (of zet hem in een QR-code en scan hem met je telefoon).
3. Draai `npm run seed` nog een keer: de demo-profielen liken dan ook jou.
4. Swipe op **Ontdek**. Een swipe naar rechts geeft direct een match, en daarna kun je chatten.

`npm test` draait de API-tests.

## Hoe het werkt

| Onderdeel | Waar |
|---|---|
| Database (SQLite): gebruikers, tickets, swipes, matches, berichten | `server/db.js` |
| API: account, tickets, ontdekken, swipen, matches, chat | `server/app.js` |
| Ticketverificatie | `server/tickets.js` |
| Realtime matches en berichten (Server-Sent Events) | `server/realtime.js` |
| Mobiele web-app (swipe-kaarten, QR-scanner, chat), PWA-manifest en service worker | `public/` |
| Beheer: evenementen, ticketcodes, meldingen | `scripts/admin.js` |
| Native iOS/Android-schil (Capacitor) | `android/`, `ios/`, `capacitor.config.json` |
| Hosting | `Dockerfile`, `fly.toml` |

**Regels die de server afdwingt:**
- Je ziet alleen profielen met een ticket voor een evenement waarvoor jij ook een ticket hebt, zolang dat evenement nog niet voorbij is.
- Voorkeuren werken in twee richtingen: jij moet in hun voorkeur passen en zij in die van jou.
- Je kunt alleen swipen op iemand met wie je een evenement deelt, dus ook niet via de API om de app heen.
- Een ticket kan maar door één account geclaimd worden. We bewaren alleen een hash van de ticketcode.
- Alleen de twee mensen in een match kunnen de chat lezen. Bij unmatchen worden de berichten verwijderd.
- Melden en blokkeren werkt in twee richtingen: jullie zien elkaar nergens meer terug. Een melding komt in de lijst van `npm run admin -- reports`.
- Je kunt je account zelf verwijderen (Profiel → Account verwijderen). Dat wist direct al je gegevens, wat Apple, Google en de AVG verplicht stellen.

## Tickets: wat nu nog nep is

Echte tickets (Paylogic, Ticketmaster, Eventix, See Tickets, TicketSwap, …) hebben elk hun eigen barcodeformaat. Of een ticket echt is, kun je alleen controleren via de API van de ticketprovider of de organisator. Voor nu gebruikt de app eigen ondertekende codes (`SS1.<event>.<serienummer>.<HMAC>`), zodat niemand zelf een geldig ticket kan verzinnen.

Een echte provider koppelen = een extra verifier toevoegen aan `PROVIDERS` in `server/tickets.js` die een gescande code herkent, hem bij de provider controleert en het `eventId` teruggeeft. De rest van de app hoeft daarvoor niet te veranderen.

## Online zetten (Fly.io)

De app draait als één Docker-container met een vaste schijf voor de SQLite-database. Fly.io kan dat goedkoop en heeft servers in Amsterdam (`ams`).

```bash
# eenmalig: installeer flyctl (https://fly.io/docs/flyctl/install/) en log in
fly auth login
fly launch --no-deploy --copy-config        # kies een unieke appnaam en pas fly.toml aan
fly volumes create sexyselectie_data --region ams --size 1
fly secrets set TICKET_SECRET=$(openssl rand -base64 32)
fly deploy
```

Je app staat dan op `https://<appnaam>.fly.dev`. Bewaar `TICKET_SECRET` goed: als het geheim verandert, worden alle uitgegeven ticketcodes ongeldig.

### Evenementen en tickets beheren

Op de server (`fly ssh console`, daarna `cd /app`), of lokaal met dezelfde `DB_FILE` en `TICKET_SECRET`:

```bash
npm run admin -- add-event mijnfestival-2027 "Festivalnaam" "Locatie" "Stad" 2027-08-20T12:00:00+02:00 2027-08-23T02:00:00+02:00
npm run admin -- events
npm run admin -- tickets mijnfestival-2027 500 > codes.csv   # ticketcodes om als QR-code uit te delen
npm run admin -- reports                                  # open meldingen
npm run admin -- handle-report 3
npm run admin -- delete-user iemand@example.com
```

## Op je telefoon

**Als installeerbare web-app (PWA)**, zodra de app online staat:
- **iPhone:** open de link in Safari → Deel → *Zet op beginscherm*.
- **Android:** open de link in Chrome → *App installeren*. In de app staat ook een knop onder Profiel.

De app opent dan zonder browserbalk en met een eigen icoon. Zonder verbinding toont hij een offline-scherm.

**In de App Store en de Play Store (Capacitor).** De mappen `android/` en `ios/` zijn native projecten die de online app laden (`server.url` in `capacitor.config.json`). Zet die URL eerst op je eigen Fly-adres en draai dan:

```bash
npm run cap:sync
npm run android     # opent Android Studio → Run, of Build → Generate Signed Bundle voor de Play Store
npm run ios         # opent Xcode (alleen op een Mac) → Run, of Product → Archive voor de App Store
```

Wat je daarvoor nodig hebt: Android Studio, en voor iOS een Mac met Xcode. Een Google Play-ontwikkelaarsaccount kost eenmalig $25, een Apple Developer-account $99 per jaar. De iconen en splashscreens staan in `assets/`. Na een nieuw icoon draai je `npx @capacitor/assets generate` en zet je daarna `public/manifest.webmanifest` terug, want het commando overschrijft dat bestand.

## Checklist voor de echte lancering

- [ ] `privacy.html` en `voorwaarden.html` invullen (alles tussen [haken]) en juridisch laten nakijken.
- [ ] Een e-mailadres voor support en moderatie, en iemand die meldingen dagelijks afhandelt.
- [ ] Ticketcodes uitdelen via een organisator, of een echte ticketprovider koppelen (zie hierboven).
- [ ] Back-ups van de database (bijvoorbeeld met Fly volume snapshots, die standaard dagelijks gemaakt worden).
- [ ] Voor de stores: screenshots, een beschrijving, een leeftijdsclassificatie van 18+ en een demo-account voor de reviewers.
- [ ] Apple keurt apps af die alleen een website tonen (richtlijn 4.2). Native pushmeldingen en de native camera-scanner (de volgende stap) helpen om goedgekeurd te worden.

## Instellingen

| Variabele | Betekenis |
|---|---|
| `PORT` | Poort (standaard 3000) |
| `DB_FILE` | Pad naar het SQLite-bestand (standaard `data/sexyselectie.db`) |
| `TICKET_SECRET` | Geheim voor het ondertekenen van tickets, **verplicht** als `NODE_ENV=production` |
| `NODE_ENV=production` | Zet ook `Secure`-cookies aan, dus draai dan achter HTTPS |

Camera-scannen werkt alleen via HTTPS of op `localhost`.

## Volgende stappen

- Pushmeldingen bij een match of bericht (Capacitor Push + Firebase/APNs, en Web Push voor de PWA).
- Native barcodescanner via een Capacitor-plugin (sneller, en leest ook pdf417/aztec).
- Koppelingen met echte ticketproviders.
- Meerdere foto's per profiel, opgeslagen in object storage in plaats van in de database.
- Wachtwoord vergeten / e-mailverificatie.
- "Wie is er nu op het terrein": een check-in op de dag zelf.
