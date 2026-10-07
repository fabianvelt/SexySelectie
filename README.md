# SexySelectie

TicketSwap × Tinder: je logt in, scant je ticket en ziet daarna **alleen mensen die naar hetzelfde festival of feest gaan als jij**. Swipe naar rechts, en bij een wederzijdse like opent er een chat.

## Snel starten

Vereist Node.js 22.5 of nieuwer (gebruikt de ingebouwde `node:sqlite`).

```bash
npm install
npm run seed     # demo-evenementen, demo-profielen en ticketcodes
npm start        # http://localhost:3000
```

1. Maak een account aan (18+). De bevestigingscode staat in de terminal waar `npm start` draait.
2. Ga naar **Tickets** en voer een van de ticketcodes in die `npm run seed` print (of zet hem in een QR-code en scan hem met je telefoon).
3. Draai `npm run seed` nog een keer: de demo-profielen liken dan ook jou.
4. Swipe op **Ontdek**. Een swipe naar rechts geeft direct een match, en daarna kun je chatten.

`npm test` draait de API-tests.

## Hoe het werkt

| Onderdeel | Waar |
|---|---|
| Database (SQLite): gebruikers, foto's, tickets, line-ups, swipes, matches, berichten | `server/db.js` |
| API: account, tickets, ontdekken, swipen, matches, chat | `server/app.js` |
| Ticketverificatie | `server/tickets.js` |
| Realtime matches en berichten (Server-Sent Events) | `server/realtime.js` |
| Pushmeldingen: Web Push, Firebase (Android), APNs (iPhone) | `server/push.js` |
| E-mail (bevestigen, wachtwoord vergeten) via Resend | `server/mail.js` |
| Mobiele web-app (swipe-kaarten, QR-scanner, chat), PWA-manifest en service worker | `public/` |
| Beheer: evenementen, ticketcodes, meldingen | `scripts/admin.js` |
| Native iOS/Android-schil (Capacitor) | `android/`, `ios/`, `capacitor.config.json` |
| Hosting | `Dockerfile`, `fly.toml` |

**Regels die de server afdwingt:**
- Je ziet alleen profielen met een ticket voor een evenement waarvoor jij ook een ticket hebt, zolang dat evenement nog niet voorbij is.
- Voorkeuren werken in twee richtingen: jij moet in hun voorkeur passen en zij in die van jou.
- Je kunt alleen swipen op iemand met wie je een evenement deelt, dus ook niet via de API om de app heen.
- Een ticket kan maar door één account geclaimd worden. We bewaren alleen een hash van de ticketcode.
- Per profiel maximaal 6 foto's (JPEG, PNG of WebP, gecontroleerd op inhoud). Foto's zijn alleen op te halen als je bent ingelogd, via een id dat niet te raden is.
- Je kiest alleen acts uit de line-up van een evenement waarvoor je een ticket hebt. Wie dezelfde acts wil zien, staat eerder in je stapel en op de kaart staat "Allebei naar …".
- Alleen de twee mensen in een match kunnen de chat lezen. Bij unmatchen worden de berichten verwijderd.
- Melden en blokkeren werkt in twee richtingen: jullie zien elkaar nergens meer terug. Een melding komt in de lijst van `npm run admin -- reports`.
- Pas na het bevestigen van je e-mailadres ben je zichtbaar voor anderen en kun je swipen en chatten. Tickets scannen en je profiel invullen kan al eerder.
- Codes uit mails zijn eenmalig, verlopen (bevestigen na 24 uur, wachtwoord na 30 minuten) en werken na 5 foute pogingen niet meer. Na 10 mislukte inlogpogingen wordt een e-mailadres een kwartier geblokkeerd.
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
npm run admin -- lineup mijnfestival-2027 "Act 1" "Act 2"     # line-up invoeren (zonder namen: tonen)
npm run admin -- remove-act mijnfestival-2027 "Act 1"
npm run admin -- reports                                  # open meldingen
npm run admin -- handle-report 3
npm run admin -- verify-user iemand@example.com           # e-mailadres handmatig bevestigen
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

## E-mail

Na het registreren krijg je een mail met een code van 6 cijfers en een link om je e-mailadres te bevestigen. Via *Wachtwoord vergeten?* op het inlogscherm krijg je een code om een nieuw wachtwoord te kiezen. Daarmee worden al je andere sessies uitgelogd. De code werkt ook in de geïnstalleerde app; een link uit een mail opent op iPhone vaak in Safari in plaats van in de app.

Zonder instellingen komen de mails in de serverlog (`fly logs`), handig om lokaal te testen. Om echt te mailen gebruik je [Resend](https://resend.com) (gratis tot 3000 mails per maand):

1. Maak een account aan en voeg onder *Domains* je eigen domein toe (bijv. `sexyselectie.nl`). Zet de DNS-records die Resend toont bij je domeinprovider. Zonder eigen domein kun je alleen naar je eigen adres mailen.
2. Maak onder *API Keys* een sleutel aan en zet die op de server:
   ```bash
   fly secrets set RESEND_API_KEY=re_... MAIL_FROM="SexySelectie <hallo@sexyselectie.nl>" APP_URL=https://<appnaam>.fly.dev
   ```

Wil je in een eerste testronde met vrienden even zonder bevestiging werken? Zet dan `REQUIRE_EMAIL_VERIFICATION=false`. Een enkel account bevestig je met de hand via `npm run admin -- verify-user iemand@example.com`.

## Pushmeldingen

Je krijgt een melding bij een nieuwe match en bij een nieuw bericht, maar alleen als je de app niet open hebt (anders komt het al live binnen). De inhoud van een bericht staat bewust niet in de melding, omdat die op een vergrendeld scherm te zien is. Je zet meldingen aan of uit onder **Profiel**. Zolang ze uit staan, verschijnt er ook een herinnering bij **Matches**.

Elk kanaal is optioneel. Wat je niet instelt, staat uit, en de server toont bij het opstarten welke kanalen actief zijn.

**1. Web Push (PWA, Android en iPhone vanaf iOS 16.4 als de app op het beginscherm staat)**

```bash
npm run vapid                                   # maakt een publieke en een privésleutel
fly secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:jij@example.com
```

**2. Android-app (Firebase Cloud Messaging)**
1. Maak een gratis project op [console.firebase.google.com](https://console.firebase.google.com) en voeg een Android-app toe met pakketnaam `nl.sexyselectie.app`.
2. Download `google-services.json` en zet hem in `android/app/`.
3. Ga naar Projectinstellingen → Serviceaccounts → *Nieuwe privésleutel genereren* en zet die JSON als secret:
   `fly secrets set FCM_SERVICE_ACCOUNT="$(base64 < serviceaccount.json | tr -d '\n')"`

**3. iPhone-app (APNs)**
1. Ga in je Apple Developer-account naar Certificates, IDs & Profiles → Keys → **+**, vink *Apple Push Notifications service* aan en download de `.p8`-sleutel.
2. Zet in Xcode bij Signing & Capabilities je team. Push is al aangezet in `App.entitlements`.
3. `fly secrets set APNS_KEY="$(base64 < AuthKey_XXXX.p8 | tr -d '\n')" APNS_KEY_ID=XXXX APNS_TEAM_ID=YYYY APNS_BUNDLE_ID=nl.sexyselectie.app APNS_PRODUCTION=true`
   Gebruik `APNS_PRODUCTION=false` zolang je test met een build die je vanuit Xcode op je telefoon zet.

## Ticketscanner

In de iOS- en Android-app opent **Ticket scannen** de scanner van je telefoon (`@capacitor/barcode-scanner`). Die leest QR-codes en ook de barcodes die op veel e-tickets staan (pdf417, aztec, code128). In de browser of PWA gebruikt de app de camera via de browser: alle formaten op Android/Chrome, en op iPhone alleen QR-codes.

## Checklist voor de echte lancering

- [ ] `privacy.html` en `voorwaarden.html` invullen (alles tussen [haken]) en juridisch laten nakijken.
- [ ] Een e-mailadres voor support en moderatie, en iemand die meldingen dagelijks afhandelt.
- [ ] Ticketcodes uitdelen via een organisator, of een echte ticketprovider koppelen (zie hierboven).
- [ ] Back-ups van de database (bijvoorbeeld met Fly volume snapshots, die standaard dagelijks gemaakt worden).
- [ ] Voor de stores: screenshots, een beschrijving, een leeftijdsclassificatie van 18+ en een demo-account voor de reviewers.
- [ ] Apple keurt apps af die alleen een website tonen (richtlijn 4.2). Native pushmeldingen en de native ticketscanner zitten er nu in, wat de kans op goedkeuring vergroot.
- [ ] Pushmeldingen instellen (Firebase en APNs, zie hierboven) en testen op een echte telefoon.
- [ ] Resend instellen met je eigen domein (zie *E-mail*), zodat bevestigings- en wachtwoordmails echt aankomen.

## Instellingen

| Variabele | Betekenis |
|---|---|
| `PORT` | Poort (standaard 3000) |
| `DB_FILE` | Pad naar het SQLite-bestand (standaard `data/sexyselectie.db`) |
| `TICKET_SECRET` | Geheim voor het ondertekenen van tickets, **verplicht** als `NODE_ENV=production` |
| `NODE_ENV=production` | Zet ook `Secure`-cookies aan, dus draai dan achter HTTPS |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (optioneel) |
| `FCM_SERVICE_ACCOUNT` | Firebase-serviceaccount als JSON of base64 (optioneel) |
| `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRODUCTION` | Apple-push (optioneel) |
| `RESEND_API_KEY`, `MAIL_FROM` | E-mail via Resend; zonder sleutel komen mails in de log |
| `APP_URL` | Adres van de app voor links in mails (bijv. `https://sexyselectie.fly.dev`) |
| `REQUIRE_EMAIL_VERIFICATION` | `false` om e-mailbevestiging tijdelijk uit te zetten (standaard aan) |

Camera-scannen werkt alleen via HTTPS of op `localhost`.

## Volgende stappen

- Koppelingen met echte ticketproviders.
- Meerdere foto's per profiel, opgeslagen in object storage in plaats van in de database.
- "Wie is er nu op het terrein": een check-in op de dag zelf.
