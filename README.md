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
| Mobiele web-app (swipe-kaarten, QR-scanner, chat) | `public/` |

**Regels die de server afdwingt:**
- Je ziet alleen profielen met een ticket voor een evenement waarvoor jij ook een ticket hebt, zolang dat evenement nog niet voorbij is.
- Voorkeuren werken in twee richtingen: jij moet in hun voorkeur passen en zij in die van jou.
- Je kunt alleen swipen op iemand met wie je een evenement deelt, dus ook niet via de API om de app heen.
- Een ticket kan maar door één account geclaimd worden. We bewaren alleen een hash van de ticketcode.
- Alleen de twee mensen in een match kunnen de chat lezen. Bij unmatchen worden de berichten verwijderd.

## Tickets: wat nu nog nep is

Echte tickets (Paylogic, Ticketmaster, Eventix, See Tickets, TicketSwap, …) hebben elk hun eigen barcodeformaat. Of een ticket echt is, kun je alleen controleren via de API van de ticketprovider of de organisator. Voor nu gebruikt de app eigen ondertekende codes (`SS1.<event>.<serienummer>.<HMAC>`), zodat niemand zelf een geldig ticket kan verzinnen.

Een echte provider koppelen = een extra verifier toevoegen aan `PROVIDERS` in `server/tickets.js` die een gescande code herkent, hem bij de provider controleert en het `eventId` teruggeeft. De rest van de app hoeft daarvoor niet te veranderen.

## Productie-instellingen

| Variabele | Betekenis |
|---|---|
| `PORT` | Poort (standaard 3000) |
| `DB_FILE` | Pad naar het SQLite-bestand (standaard `data/sexyselectie.db`) |
| `TICKET_SECRET` | Geheim voor het ondertekenen van tickets, **verplicht** als `NODE_ENV=production` |
| `NODE_ENV=production` | Zet ook `Secure`-cookies aan, dus draai dan achter HTTPS |

Camera-scannen werkt alleen via HTTPS of op `localhost`.

## Ideeën voor de volgende stap

- Koppelingen met echte ticketproviders.
- Meerdere foto's per profiel en opslag in object storage in plaats van in de database.
- Melden en blokkeren, plus moderatie.
- Pushmeldingen bij een match of bericht.
- Native app (bijvoorbeeld React Native of Expo) bovenop dezelfde API.
- "Wie is er nu op het terrein": een check-in op de dag zelf.
