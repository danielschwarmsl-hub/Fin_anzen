// Händler- und Zahlungsempfänger-Liste (DE/EU).
// Muster sind Regex-Quellen gegen "gefalteten" Text (fold): klein, ohne Umlaute/Akzente (ä→ae, ß→ss),
// "&" → " and ", alle übrigen Sonderzeichen (. , * / - _) → Leerzeichen, "+" bleibt.
// Wortgrenzen (kein Buchstabe/keine Ziffer davor/danach) werden automatisch ergänzt; Wortanfänge mit [a-z]* öffnen.
// Reihenfolge zählt: spezifische Einträge stehen vor allgemeinen (ALDI Talk vor ALDI, Globus Baumarkt vor Globus ...).
//
// Eintrag: { id, name, category, sub, re, recurringHint, intermediary, conf, cpOnly, refine }
//  - cpOnly: nur gegen die Gegenpartei prüfen (im Verwendungszweck zu mehrdeutig)
//  - refine: 'insurance' | 'wohnen' → Unterkategorie wird aus dem Verwendungszweck verfeinert (rules.js)
//  - intermediary: Zahlungsdienstleister – liefert keine Kategorie, nur den Hinweis
//  - conf < 0.6: "schwacher" Treffer, Stichwortregeln haben Vorrang

/** Text für den Mustervergleich glätten */
export function fold(s) {
  return String(s || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9+]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const foldPattern = (p) => p.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/&/g, ' and ');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LIST = [];
/**
 * Gruppe von Händlern mit gleicher Kategorie.
 * Eintrag: 'Name' (Muster = gefalteter Name) | ['Name', 'regex'] | ['Name', 'regex', { überschreibt opts }]
 */
function G(category, sub, opts, entries) {
  for (const e of entries) {
    const [name, pat, own] = Array.isArray(e) ? e : [e];
    const src = pat ? foldPattern(pat) : esc(fold(name)).replace(/ /g, ' ?');
    const o = { ...opts, ...(own || {}) };
    LIST.push({
      id: 'm' + LIST.length, name, category, sub: o.sub ?? sub, src, re: new RegExp('(?<![a-z0-9])(?:' + src + ')(?![a-z0-9])'),
      recurringHint: o.recurringHint || null, intermediary: !!o.intermediary, conf: o.conf ?? 0.9,
      cpOnly: !!o.cpOnly, refine: o.refine || null,
    });
  }
}

// ---------------------------------------------------------------- Lebensmittel
G('wohnen', 'internet_telefon', { recurringHint: 'monthly' }, [['ALDI Talk', 'aldi talk[a-z ]*']]);
G('wohnen', 'einrichtung', {}, [['Globus Baumarkt', 'globus bau[a-z]*']]);
G('lebensmittel', 'supermarkt', {}, [
  ['REWE', 'rewe[a-z]*'], ['EDEKA', 'edeka[a-z]*|e center|e neukauf'], ['ALDI', 'aldi(?: sued| nord| sud)?'], ['Lidl', 'lidl[a-z]*'],
  ['Penny', 'penny(?: markt)?', { cpOnly: true }], ['Netto', 'netto marken[a-z ]*|netto (?:markt|filiale|city|discount)'], ['Kaufland', 'kaufland[a-z]*'],
  ['Norma', 'norma(?: lebensmittel[a-z]*| filial[a-z]*| markt)'], ['tegut', 'tegut[a-z]*'],
  ['Globus', 'globus(?: sb[a-z ]*| markt| handelshof)?', { cpOnly: true }], ['real', 'real (?:sb|markt|filiale|warenhaus)', { cpOnly: true }],
  ['Marktkauf', 'marktkauf'], ['Nahkauf', 'nahkauf|nah and gut'], ['Famila', 'famila[a-z ]*'], ['Combi', 'combi (?:verbrauchermarkt|markt)'],
  ['Hit', 'hit (?:markt|ullrich|verbrauchermarkt)'], ['V-Markt', 'v markt'], ['Bio Company', 'bio company'], ['Alnatura', 'alnatura'],
  ['Denn\'s Biomarkt', 'denns(?: biomarkt)?|denn s biomarkt|basic bio|biomarkt'], ['Picnic', 'picnic(?: lieferdienst| deutschland)?'],
  ['Metro', 'metro (?:cash|ag|grosshandel|deutschland)'], ['Selgros', 'selgros'], ['Mix Markt', 'mix markt'], ['Wochenmarkt', 'wochenmarkt|hofladen'],
  ['Metzgerei', 'metzgerei[a-z ]*|fleischerei[a-z ]*', { sub: 'baeckerei' }],
]);
G('lebensmittel', 'baeckerei', { cpOnly: true }, [
  ['Bäckerei', 'baeckerei[a-z ]*|baecker[a-z ]*|baeckerhaus|backshop|backwerk|back factory|le crobag'], ['Kamps', 'kamps'], ['Ditsch', 'ditsch'], ['Brezelkönig', 'brezelkoenig'],
]);
G('lebensmittel', 'lieferdienst', {}, [
  ['Flink', 'flink(?: se| food)?', { cpOnly: true }], ['Getir', 'getir'], ['Gorillas', 'gorillas'], ['Knuspr', 'knuspr'], ['HelloFresh', 'hello ?fresh', { recurringHint: 'monthly' }],
  ['Marley Spoon', 'marley spoon'], ['Lieferando', 'lieferando|just eat(?: takeaway)?'], ['Wolt', 'wolt', { cpOnly: true }], ['Uber Eats', 'uber ?eats'], ['Foodora', 'foodora'],
  ['Flaschenpost', 'flaschenpost'],
]);
G('lebensmittel', 'drogerie', {}, [
  ['dm', 'dm drogerie[a-z ]*|dm markt|dm fil[a-z]*'], ['Rossmann', 'rossmann[a-z ]*'],
  ['Müller', 'mueller (?:drogerie|handels|markt|filiale)|drogerie mueller'], ['Budni', 'budni|budnikowsky'],
]);
G('lebensmittel', 'restaurant', {}, [
  ['McDonald\'s', 'mc ?donald ?s?[a-z ]*'], ['Burger King', 'burger king'], ['KFC', 'kfc|kentucky fried'], ['Subway', 'subway(?: restaurant| sandwich)?', { cpOnly: true }],
  ['Starbucks', 'starbucks[a-z ]*'], ['Vapiano', 'vapiano'], ['L\'Osteria', 'l osteria|losteria'], ['Block House', 'block house'], ['Hans im Glück', 'hans im glueck'],
  ['Nordsee', 'nordsee'], ['Dean & David', 'dean and david'], ['Pizza Hut', 'pizza hut'], ['Domino\'s', 'domino s?(?: pizza)?'], ['Five Guys', 'five guys'],
  ['Coffee Fellows', 'coffee fellows'], ['Espresso House', 'espresso house'],
  ['Restaurant', 'restaurant[a-z ]*|gaststaette|ristorante|trattoria|pizzeria|gasthof|gasthaus|brauhaus|imbiss|bistro|cafe|kaffeehaus|biergarten|taverne|doener|kebab|sushi', { cpOnly: true, conf: 0.8 }],
]);
G('lebensmittel', 'kiosk', { cpOnly: true }, [['Kiosk', 'kiosk|spaeti|tabakwaren|trinkgut|getraenkemarkt']]);

// ---------------------------------------------------------------- Mobilität
G('mobilitaet', 'tanken', {}, [
  ['Aral', 'aral(?: tankstelle| station)?'], ['Shell', 'shell(?: tankstelle| station| deutschland)?'], ['Esso', 'esso(?: tankstelle| station)?'],
  ['TotalEnergies', 'total ?energies|total (?:tankstelle|station|deutschland)'], ['JET', 'jet (?:tankstelle|tank[a-z]*|station)'], ['STAR', 'star (?:tankstelle|station|tankstellen)'],
  ['HEM', 'hem (?:tankstelle|station|tank)'], ['Agip/Eni', 'agip|eni (?:station|tankstelle)'], ['OMV', 'omv'], ['Avia', 'avia(?: tankstelle| station)?'], ['bft', 'bft(?: tankstelle| station)?'],
  ['Orlen', 'orlen'], ['Tamoil', 'tamoil'], ['Tankstelle', 'tankstelle[a-z ]*|autohof|tank and rast|tank rast', { conf: 0.8 }],
]);
G('mobilitaet', 'auto', {}, [
  ['Parken', 'parkhaus[a-z ]*|apcoa|q park|qpark|park and joy|easypark|parkster|parkone|parkscheinautomat|parknow|parkgebuehr[a-z ]*'],
  ['Toll Collect', 'toll collect'], ['ADAC', 'adac(?: e v| mitglied[a-z]*)?', { recurringHint: 'yearly' }],
  ['TÜV', 'tuev (?:nord|sued|hessen|rheinland)|dekra|gtue|a t u|atu (?:auto|werkstatt)|pit stop|vergoelst|carglass|autowerkstatt|kfz werkstatt|reifen[a-z ]*|autoteile[a-z ]*'],
]);
G('mobilitaet', 'oepnv', {}, [
  ['Deutschlandticket', 'deutschland ?ticket|d ticket|deutschlandabo', { recurringHint: 'monthly' }], ['HVV', 'hvv(?: switch)?|hamburger hochbahn|hochbahn'],
  ['BVG', 'bvg|berliner verkehrsbetriebe'], ['VBB', 'vbb(?: fahrinfo)?'], ['MVV', 'mvv|mvg(?: muenchen)?'], ['VRR', 'vrr'], ['KVB', 'kvb'], ['RMV', 'rmv'], ['VVS', 'vvs'],
  ['Rheinbahn', 'rheinbahn'], ['Üstra', 'uestra'], ['Verkehrsverbund', 'verkehrsverbund[a-z ]*|verkehrsbetriebe[a-z ]*|verkehrsgesellschaft[a-z ]*|nahverkehr[a-z ]*', { conf: 0.8 }],
]);
G('mobilitaet', 'bahn_fernverkehr', {}, [
  ['Deutsche Bahn', 'deutsche bahn(?: ag| vertrieb| fernverkehr)?|db (?:vertrieb|fernverkehr|regio|bahn)|bahn de|bahncard|db navigator'],
  ['FlixBus', 'flix ?bus|flixtrain|flix se'], ['BlaBlaCar', 'blablacar'], ['Omio', 'omio'], ['Trainline', 'trainline'], ['ÖBB', 'oebb'], ['SBB', 'sbb'],
]);
G('mobilitaet', 'taxi_sharing', {}, [
  ['Uber', 'uber(?: bv| b v| trip| technologies)?'], ['Bolt', 'bolt(?: operations| ride| technology)?', { cpOnly: true }], ['Free Now', 'free ?now|mytaxi'],
  ['Taxi', 'taxi[a-z ]*|funk taxi|taxizentrale', { cpOnly: true }], ['Share Now', 'share ?now'], ['Miles', 'miles mobility', { cpOnly: true }], ['Cambio', 'cambio carsharing'],
  ['Flinkster', 'flinkster'], ['Sixt', 'sixt(?: rent[a-z ]*| share| gmbh)?'], ['Europcar', 'europcar'], ['Hertz', 'hertz'], ['Tier', 'tier (?:mobility|scooter)'],
  ['Lime', 'lime(?: bike| scooter)?', { cpOnly: true }], ['Voi', 'voi (?:technology|scooter)'], ['Dott', 'dott (?:scooter|mobility)'], ['nextbike', 'nextbike|call a bike'],
]);

// ---------------------------------------------------------------- Reisen & Freizeit
G('freizeit_reisen', 'urlaub', {}, [
  ['Lufthansa', 'lufthansa[a-z ]*'], ['Eurowings', 'eurowings'], ['Ryanair', 'ryanair'], ['easyJet', 'easy ?jet'], ['Condor', 'condor(?: flugdienst)?'], ['TUIfly', 'tui ?fly'],
  ['Wizz Air', 'wizz ?air'], ['Vueling', 'vueling'], ['KLM', 'klm'], ['Air France', 'air france'], ['Turkish Airlines', 'turkish airlines'],
  ['TUI', 'tui(?: deutschland| cruises| travel)?|dertour|alltours|schauinsland|fti'], ['Weg.de', 'weg de|urlaubsguru|ab in den urlaub|opodo|edreams|momondo|kayak|skyscanner'],
  ['Check24 Reisen', 'check24 reise[a-z ]*'], ['AIDA', 'aida cruises|aida kreuzfahrten'], ['Center Parcs', 'center parcs|europa park|ferienhaus[a-z ]*'],
]);
G('freizeit_reisen', 'hotel', {}, [
  ['Booking.com', 'booking ?com(?: b v)?'], ['Airbnb', 'airbnb[a-z ]*'], ['Hotels.com', 'hotels ?com'], ['Expedia', 'expedia'], ['HRS', 'hrs(?: hotel[a-z ]*)?'], ['Trivago', 'trivago'],
  ['Agoda', 'agoda'], ['Hostelworld', 'hostelworld'], ['Motel One', 'motel one'], ['B&B Hotels', 'b and b hotel[a-z]*'], ['A&O Hostels', 'a and o hostel[a-z ]*'],
  ['Hotel', 'hotel[a-z ]*|pension[a-z ]*|ferienwohnung[a-z ]*|campingplatz[a-z ]*|camping[a-z ]*', { cpOnly: true, conf: 0.8 }],
]);
G('freizeit_reisen', 'kultur', { cpOnly: true }, [
  ['Kino', 'kino[a-z ]*|cinemaxx|cinestar|uci kinowelt|cineplex|cinecitta|filmpalast|kinopolis|multiplex'], ['Ticketmaster', 'ticketmaster'], ['Eventim', 'eventim|reservix|adticket|ticket ?online|dasticket'],
  ['Theater', 'theater[a-z ]*|konzerthaus|philharmonie|elbphilharmonie|musical[a-z ]*|stage entertainment|mehr theater'], ['Museum', 'museum[a-z ]*'],
  ['Zoo', 'zoo|tierpark[a-z ]*|freizeitpark[a-z ]*|heide park|phantasialand|movie park|hansa park|legoland|serengeti park'], ['Bowling', 'bowling[a-z ]*|minigolf|kletterhalle|boulderhalle|escape room[a-z ]*'],
]);
G('freizeit_reisen', 'geschenke', { cpOnly: true }, [
  ['Fleurop', 'fleurop|blume2000|valentins|miflora|blumenversand|florist[a-z ]*|blumen[a-z ]*'], ['mydays', 'mydays|jochen schweizer'], ['Tonies', 'tonies|toniebox'],
]);
G('freizeit_reisen', 'hobby', { cpOnly: true }, [['Fotobuch', 'cewe(?: fotobuch)?|pixum|saal digital|posterxxl|myposter|fotokasten|photobox'], ['Spreadshirt', 'spreadshirt|vistaprint|flyeralarm|printful']]);

// ---------------------------------------------------------------- Wohnen
G('wohnen', 'internet_telefon', { recurringHint: 'monthly' }, [
  ['Telekom', 'telekom(?: deutschland| mobilfunk)?|deutsche telekom|magenta ?(?:tv|eins|mobil)?|t mobile|t online'],
  ['Vodafone', 'vodafone[a-z ]*|kabel deutschland|unitymedia'], ['O2', 'o2(?: telefonica| online)?|telefonica[a-z ]*'],
  ['1&1', '1 and 1(?: telecom| versatel| ionos)?|1und1|versatel'], ['congstar', 'congstar'], ['freenet', 'freenet(?: digital)?|mobilcom(?: debitel)?'],
  ['klarmobil', 'klarmobil'], ['WinSIM', 'winsim|simyo|drillisch|yourfone|lebara|otelo|premiumsim|netzclub|sim de'], ['Blau', 'blau(?: mobilfunk| de)', {}],
  ['PŸUR', 'pyur|netcologne|m net|wilhelm tel|ewe tel|deutsche glasfaser|tele columbus|sipgate|fonial'],
]);
G('wohnen', 'strom_gas', { recurringHint: 'monthly' }, [
  ['Vattenfall', 'vattenfall[a-z ]*'], ['E.ON', 'e on(?: energie| energy| se| vertrieb)?|eon(?: energie| vertrieb)?|eprimo'], ['EnBW', 'enbw[a-z ]*'],
  ['Yello', 'yello(?: strom)?'], ['EWE', 'ewe(?: vertrieb| ag| netz)?'], ['Entega', 'entega'], ['Mainova', 'mainova'], ['RWE', 'rwe(?: energy| vertrieb| supply)?|innogy'],
  ['Gasag', 'gasag'], ['Hamburger Energiewerke', 'hamburg energie|hamburger energiewerke|enercity|badenova|rhein ?energie|swm versorgung|suewag|thuega|n ergie|e wie einfach|maingau'],
  ['Naturstrom', 'naturstrom|polarstern|ostrom|1komma5|gruenwelt'], ['Lichtblick', 'lichtblick'], ['Tibber', 'tibber'], ['Octopus Energy', 'octopus(?: energy)?'],
  ['Stadtwerke', 'stadtwerke[a-z ]*|energieversorgung[a-z ]*|energie und wasser[a-z ]*|grundversorger'],
]);
G('wohnen', 'nebenkosten', {}, [
  ['Hamburg Wasser', 'hamburg wasser|wasserwerke[a-z ]*|wasserversorgung[a-z ]*|abwasser[a-z ]*|stadtentwaesserung'],
  ['Müllabfuhr', 'abfallwirtschaft[a-z ]*|stadtreinigung[a-z ]*|muellabfuhr|schornsteinfeger[a-z ]*'], ['Hausgeld', 'hausgeld|wohngeld|nebenkosten[a-z ]*|betriebskosten[a-z ]*'],
]);
G('wohnen', 'rundfunk', { recurringHint: 'quarterly' }, [['Rundfunkbeitrag', 'ard zdf deutschlandradio|rundfunk(?:beitrag)?[a-z ]*|beitragsservice']]);
G('wohnen', 'miete', { recurringHint: 'monthly', conf: 0.8, refine: 'wohnen' }, [
  ['Hausverwaltung', 'hausverwaltung[a-z ]*|mietverwaltung[a-z ]*|hausverwalter'], ['Wohnungsbau', 'wohnungsbau[a-z ]*|wohnungsgenossenschaft[a-z ]*|wohnbau[a-z ]*|baugenossenschaft[a-z ]*'],
  ['Vonovia', 'vonovia|deutsche wohnen|leg immobilien|gewobag|degewo|howoge|saga gwg|saga unternehmensgruppe|grand city'], ['Immobilien', 'immobilien(?:verwaltung)?[a-z ]*', { cpOnly: true, conf: 0.7 }],
]);
G('wohnen', 'einrichtung', {}, [
  ['Bauhaus', 'bauhaus'], ['OBI', 'obi(?: markt| baumarkt| gmbh)?'], ['Hornbach', 'hornbach'], ['toom', 'toom(?: baumarkt)?'], ['hagebau', 'hagebau(?:markt)?'], ['Hellweg', 'hellweg'],
  ['Baumarkt', 'baumarkt[a-z ]*|bauzentrum', { cpOnly: true }],
]);
G('wohnen', 'handwerker', { cpOnly: true, conf: 0.8 }, [
  ['Elektro', 'elektro[a-z ]*|elektriker[a-z ]*|elektroinstallation[a-z ]*'], ['Sanitär', 'sanitaer[a-z ]*|installateur[a-z ]*|heizung[a-z ]*|klempner[a-z ]*'],
  ['Maler', 'maler(?:betrieb|meister)?[a-z ]*|tischlerei[a-z ]*|schreinerei[a-z ]*|dachdecker[a-z ]*|gebaeudereinigung[a-z ]*|hausmeister[a-z ]*|gartenbau[a-z ]*|gartenpflege[a-z ]*|schluesseldienst[a-z ]*|handwerk[a-z ]*'],
]);

// ---------------------------------------------------------------- Abos & Medien
G('abos_medien', 'streaming', { recurringHint: 'monthly' }, [
  ['Netflix', 'netflix[a-z ]*'], ['Disney+', 'disney ?\\+?|disney plus|disney streaming'], ['Amazon Prime', 'amazon prime[a-z ]*|prime video|prime mitgliedschaft|amzn prime'],
  ['DAZN', 'dazn[a-z ]*'], ['Sky', 'sky (?:deutschland|ticket|q|abo|fernsehen|entertainment)|wow tv|sky de', {}], ['RTL+', 'rtl ?\\+|rtl plus|rtl deutschland'], ['Joyn', 'joyn(?: plus)?'],
  ['Paramount+', 'paramount ?\\+?|paramount plus'], ['waipu.tv', 'waipu(?: tv)?|zattoo'], ['Crunchyroll', 'crunchyroll'], ['MagentaTV', 'magenta ?tv'], ['Twitch', 'twitch(?: interactive)?'],
  ['YouTube', 'youtube(?: premium| music)?|google youtube|youtubepremium'], ['Apple', 'apple ?com bill|apple services|itunes|apple tv\\+?|apple one|apple arcade|apple distribution'],
]);
G('abos_medien', 'musik', { recurringHint: 'monthly' }, [
  ['Spotify', 'spotify[a-z ]*'], ['Apple Music', 'apple music'], ['Deezer', 'deezer'], ['Tidal', 'tidal'], ['SoundCloud', 'soundcloud'], ['Amazon Music', 'amazon music'], ['Qobuz', 'qobuz'],
]);
G('abos_medien', 'hoerbuch', { recurringHint: 'monthly' }, [
  ['Audible', 'audible[a-z ]*'], ['Kindle Unlimited', 'kindle unlimited'], ['Storytel', 'storytel'], ['BookBeat', 'bookbeat'], ['Skoobe', 'skoobe'], ['Blinkist', 'blinkist'],
]);
G('abos_medien', 'cloud', { recurringHint: 'monthly' }, [
  ['iCloud', 'icloud(?: storage| speicher)?|apple icloud'], ['Google One', 'google (?:one|storage|workspace|cloud)|gsuite|g suite'], ['Dropbox', 'dropbox[a-z ]*'], ['OneDrive', 'onedrive'],
  ['pCloud', 'pcloud|tresorit|mega limited|backblaze'], ['Proton', 'proton(?: ag| mail| drive| vpn| technologies)?'], ['Hetzner', 'hetzner(?: online)?'], ['IONOS', 'ionos|strato|netcup|host europe|all inkl|hostinger'],
  ['DigitalOcean', 'digitalocean|cloudflare|namecheap|godaddy|vercel|netlify|heroku|scaleway|ovh(?:cloud)?|contabo|amazon web services|aws emea'], ['Squarespace', 'squarespace|wix ?com|jimdo|webflow'],
]);
G('abos_medien', 'software', { recurringHint: 'monthly' }, [
  ['Adobe', 'adobe[a-z ]*'], ['Microsoft', 'microsoft[a-z ]*|msft|office 365|msbill|xbox(?: game pass| live)?'], ['Google', 'google(?: play| ireland| payment| llc| ads)?|google \\*[a-z ]*'],
  ['ChatGPT', 'openai[a-z ]*|chat ?gpt[a-z ]*'], ['Claude', 'anthropic[a-z ]*|claude(?: ai| pro| max)?'], ['Perplexity', 'perplexity|midjourney|elevenlabs|deepl(?: se| pro)?|suno|runway'],
  ['GitHub', 'github[a-z ]*|jetbrains|replit|lovable|cursor(?: ai)?'], ['Notion', 'notion(?: labs)?'], ['Evernote', 'evernote|todoist|1password|lastpass|bitwarden|dashlane|grammarly'],
  ['NordVPN', 'nordvpn|expressvpn|surfshark|mullvad'], ['Canva', 'canva[a-z ]*'], ['Figma', 'figma'], ['Slack', 'slack technologies|slack com'], ['Zoom', 'zoom (?:video|us|communications)'],
  ['Atlassian', 'atlassian|trello|asana|airtable|calendly|miro com'], ['Setapp', 'setapp|paddle(?: net)?|fastspring|readwise|raycast'], ['Tuta', 'tuta(?: com| nota)?|mailbox org|posteo|fastmail'],
]);
G('abos_medien', 'gaming', { recurringHint: 'monthly' }, [
  ['Steam', 'steam(?: games| purchase| community)?|steampowered|valve corp'], ['PlayStation', 'playstation(?: network| store| plus)?|sony interactive'],
  ['Nintendo', 'nintendo(?: eshop| switch online)?'], ['Epic Games', 'epic games'], ['Ubisoft', 'ubisoft'], ['Electronic Arts', 'electronic arts|ea play'], ['Blizzard', 'blizzard|battle net'],
  ['Riot Games', 'riot games'], ['Humble Bundle', 'humble bundle|gog com'], ['Roblox', 'roblox|supercell|minecraft|mojang'],
]);
G('abos_medien', 'zeitung', { recurringHint: 'monthly' }, [
  ['Der Spiegel', 'spiegel(?: verlag| plus| gruppe)?|der spiegel'], ['Die Zeit', 'zeit online|zeit verlag|die zeit'], ['FAZ', 'faz(?: de| net)?|frankfurter allgemeine'],
  ['Süddeutsche Zeitung', 'sueddeutsche(?: zeitung)?|sz de'], ['Handelsblatt', 'handelsblatt'], ['WELT', 'welt (?:plus|de|online)|(?<!fuer )(?<!aerzte der )die welt'], ['taz', 'taz(?: verlagsgenossenschaft)?'],
  ['Bild', 'bild (?:plus|de)|axel springer'], ['stern', 'stern (?:plus|de)'], ['Hamburger Abendblatt', 'abendblatt|hamburger abendblatt|morgenpost|rheinische post|tagesspiegel'],
  ['t3n', 't3n|golem|heise|netzpolitik'], ['New York Times', 'new york times|nytimes|economist|financial times|substack'], ['Readly', 'readly|pressreader'],
  ['Verlag', 'verlag[a-z ]*|zeitungsverlag[a-z ]*', { cpOnly: true, conf: 0.7 }],
]);
G('abos_medien', 'fitness', { recurringHint: 'monthly' }, [
  ['Urban Sports Club', 'urban sports(?: club)?'], ['McFit', 'mc ?fit'], ['FitX', 'fitx'], ['Clever Fit', 'clever fit'], ['John Reed', 'john reed'], ['Fitness First', 'fitness first'],
  ['EGYM Wellpass', 'egym(?: wellpass)?|wellpass|gympass'], ['Basic-Fit', 'basic fit'], ['Holmes Place', 'holmes place'], ['Kieser', 'kieser(?: training)?'], ['Peloton', 'peloton'],
  ['Strava', 'strava'], ['Freeletics', 'freeletics'], ['Headspace', 'headspace|calm com'],
  ['Fitnessstudio', 'fitnessstudio[a-z ]*|fitness studio[a-z ]*|sportstudio[a-z ]*|crossfit[a-z ]*|yoga[a-z ]*|sportverein[a-z ]*|turnverein[a-z ]*|schwimmbad[a-z ]*|therme[a-z ]*', { cpOnly: true, conf: 0.8 }],
]);

// ---------------------------------------------------------------- Shopping
G('shopping', 'online', {}, [
  ['Amazon', 'amazon(?: payments(?: europe)?| eu s a r l| eu| de| marketplace| services| online| digital| com| web)?[a-z ]*|amzn(?: mktp(?: de)?| digital)?[a-z ]*', {}],
  ['Otto', 'otto(?: gmbh| versand)?|ottoversand', { cpOnly: true }], ['eBay', 'ebay(?: sarl| gmbh| com)?'], ['Kleinanzeigen', 'kleinanzeigen'],
  ['Etsy', 'etsy(?: ireland| inc)?'], ['AliExpress', 'ali ?express(?: com)?|alibaba'], ['Temu', 'temu|whaleco'], ['SHEIN', 'shein'], ['Rakuten', 'rakuten'], ['Vinted', 'vinted'],
  ['Momox', 'momox|rebuy|medimops|booklooker|zvab'], ['Baur', 'baur|witt weiden|klingel|bonprix|hessnatur|manufactum|mytoys|babymarkt', { cpOnly: true }], ['Tchibo', 'tchibo(?: gmbh)?', { cpOnly: true }],
  ['Bader', 'bader|pearl|westfalia|ernstings family|jako o', { cpOnly: true }],
]);
G('shopping', 'kleidung', { cpOnly: true }, [
  ['Zalando', 'zalando[a-z ]*'], ['About You', 'about ?you'], ['H&M', 'h and m|hm hennes|hennes and mauritz'], ['C&A', 'c and a'], ['Primark', 'primark'], ['Zara', 'zara|inditex'], ['Uniqlo', 'uniqlo'],
  ['Esprit', 'esprit'], ['Peek & Cloppenburg', 'peek and cloppenburg'], ['Breuninger', 'breuninger'], ['Galeria', 'galeria|karstadt|kaufhof'], ['Takko', 'takko|kik textilien|nkd|new yorker|tk ?maxx'],
  ['Deichmann', 'deichmann|goertz|snipes|foot locker'], ['Nike', 'nike|adidas|puma'], ['Decathlon', 'decathlon'], ['Intersport', 'intersport|sportscheck|globetrotter|bergzeit'],
  ['Hunkemöller', 'hunkemoeller|snocks|calzedonia|tezenis|intimissimi'], ['Tom Tailor', 'tom tailor|s oliver|marc o polo|gerry weber|bonita|ulla popken|jack and jones|only and sons'],
]);
G('shopping', 'elektronik', { cpOnly: true }, [
  ['MediaMarkt', 'media ?markt'], ['Saturn', 'saturn(?: electro[a-z ]*)?'], ['Expert', 'expert (?:technomarkt|elektro)|euronics'], ['Cyberport', 'cyberport'], ['notebooksbilliger', 'notebooksbilliger'],
  ['Alternate', 'alternate'], ['Mindfactory', 'mindfactory|caseking|computeruniverse'], ['Conrad', 'conrad electronic|reichelt|pollin'], ['Galaxus', 'galaxus|digitec'],
  ['Apple Store', 'apple (?:store|retail|online store|germany|sales)'], ['Samsung', 'samsung(?: electronics)?|teufel|sonos|dyson|garmin|lenovo'],
]);
G('shopping', 'moebel', {}, [
  ['IKEA', 'ikea[a-z ]*'], ['XXXLutz', 'xxx ?lutz|xxl lutz'], ['ROLLER', 'roller'], ['POCO', 'poco'], ['Höffner', 'hoeffner'], ['Segmüller', 'segmueller'], ['Maisons du Monde', 'maisons du monde'],
  ['JYSK', 'jysk'], ['home24', 'home24'], ['Westwing', 'westwing'], ['Möbel', 'moebel[a-z ]*|moemax', { cpOnly: true }], ['Dehner', 'dehner|gartencenter[a-z ]*'],
]);
G('shopping', 'buecher', { cpOnly: true }, [
  ['Thalia', 'thalia[a-z ]*'], ['Hugendubel', 'hugendubel|mayersche|osiander|weltbild'], ['Buchhandlung', 'buchhandlung[a-z ]*|buecher[a-z ]*|tolino'],
]);
G('shopping', 'sonstiges', {}, [
  ['Fressnapf', 'fressnapf|zooplus|das futterhaus|futterhaus', { cpOnly: true }], ['Action', 'action deutschland|woolworth|tedi|pepco|kik'], ['Douglas', 'douglas(?: parfuemerie)?|flaconi|notino|yves rocher|rituals|lush'],
  ['DHL', 'deutsche post(?: ag| dhl)?|dhl(?: paket| express| shop)?|dpd(?: deutschland)?|hermes(?: germany| paket)?|gls(?: germany)?|ups(?: deutschland)?|fedex|packstation|briefmarke[a-z ]*|internetmarke', { conf: 0.6 }],
  ['Tierarzt', 'tierarzt[a-z ]*|tierklinik[a-z ]*|tierbedarf[a-z ]*', { cpOnly: true, sub: 'sonstiges' }],
]);

// ---------------------------------------------------------------- Versicherungen
G('versicherungen', null, { refine: 'insurance', recurringHint: 'monthly' }, [
  ['Allianz', 'allianz[a-z ]*'], ['HUK-Coburg', 'huk ?coburg[a-z ]*|huk24|huk'], ['AXA', 'axa[a-z ]*'], ['ERGO', 'ergo(?: versicherung[a-z ]*| direkt| group)?|d a s rechtsschutz|victoria versicherung|hamburg mannheimer'],
  ['Generali', 'generali[a-z ]*|aachenmuenchener|central krankenversicherung'], ['CosmosDirekt', 'cosmos ?direkt|cosmos versicherung[a-z ]*|dialog versicherung'],
  ['Alte Leipziger', 'alte leipziger[a-z ]*|hallesche[a-z ]*'], ['R+V', 'r\\+v[a-z ]*|r and v[a-z ]*|ruv[a-z ]*|vr versicherung'], ['Debeka', 'debeka[a-z ]*'], ['Signal Iduna', 'signal iduna[a-z ]*|signal krankenversicherung|iduna'],
  ['HanseMerkur', 'hanse ?merkur[a-z ]*'], ['DEVK', 'devk[a-z ]*'], ['Barmenia', 'barmenia[a-z ]*'], ['Gothaer', 'gothaer[a-z ]*'], ['LV 1871', 'lv ?1871'], ['Hannoversche', 'hannoversche[a-z ]*'],
  ['Volkswohl Bund', 'volkswohl bund'], ['Stuttgarter', 'stuttgarter(?: lebensversicherung| versicherung[a-z ]*)?'], ['Swiss Life', 'swiss life[a-z ]*'], ['Nürnberger', 'nuernberger[a-z ]*'],
  ['Zurich', 'zurich(?: versicherung[a-z ]*| gruppe)?'], ['Concordia', 'concordia'], ['Continentale', 'continentale[a-z ]*'], ['Provinzial', 'provinzial[a-z ]*'], ['LVM', 'lvm(?: versicherung[a-z ]*)?'],
  ['WGV', 'wgv[a-z ]*'], ['VHV', 'vhv[a-z ]*'], ['Die Bayerische', 'die bayerische|bayerische versicherung[a-z ]*'], ['Sparkassenversicherung', 'sv sparkassenversicherung|sparkassenversicherung|oeffentliche versicherung[a-z ]*|versicherungskammer[a-z ]*'],
  ['Itzehoer', 'itzehoer[a-z ]*'], ['Basler', 'basler[a-z ]*|baloise'], ['Mecklenburgische', 'mecklenburgische[a-z ]*'], ['DKV', 'dkv[a-z ]*|ukv'], ['ARAG', 'arag[a-z ]*'], ['Roland', 'roland rechtsschutz|advocard'],
  ['HDI', 'hdi[a-z ]*|gerling|talanx'], ['Getsafe', 'getsafe|feather|friday finance|lemonade|clark germany|wefox|ottonova|nexible|adam riese'], ['Universa', 'universa|haftpflichtkasse|vgh|kravag|sdk|inter versicherung[a-z ]*'],
  ['Check24', 'check24(?: vergleichsportal| versicherung[a-z ]*)?'], ['Versicherung', 'versicherung(?:s)?[a-z ]*|krankenkasse|zusatzversicherung', { cpOnly: true, conf: 0.7 }],
]);

// ---------------------------------------------------------------- Spenden
G('spenden', 'organisation', { recurringHint: 'monthly' }, [
  ['Ärzte ohne Grenzen', 'aerzte ohne grenzen[a-z ]*|medecins sans frontieres'], ['UNICEF', 'unicef[a-z ]*|deutsches komitee fuer unicef'], ['WWF', 'wwf[a-z ]*|world wide fund|world wildlife'],
  ['Greenpeace', 'greenpeace[a-z ]*'], ['NABU', 'nabu'], ['BUND', 'bund fuer umwelt[a-z ]*|bund naturschutz'], ['Deutsche Umwelthilfe', 'deutsche umwelthilfe'], ['Campact', 'campact'],
  ['foodwatch', 'foodwatch'], ['Wikimedia', 'wikimedia[a-z ]*|wikipedia'], ['Mozilla Foundation', 'mozilla foundation|signal foundation|openstreetmap'], ['Amnesty International', 'amnesty[a-z ]*|human rights watch|reporter ohne grenzen'],
  ['Sea-Watch', 'sea ?watch|sos mediterranee|mission lifeline|seebruecke'], ['Ärzte der Welt', 'aerzte der welt|medico international|handicap international|sightsavers|christoffel blindenmission'],
  ['CARE', 'care deutschland'], ['Oxfam', 'oxfam'], ['Plan International', 'plan international'], ['Terre des Hommes', 'terre des hommes'], ['World Vision', 'world vision'],
  ['Save the Children', 'save the children'], ['SOS-Kinderdörfer', 'sos kinderdoerfer'], ['Kindernothilfe', 'kindernothilfe|deutsche kinderhilfe|deutsches kinderhilfswerk'], ['Caritas', 'caritas[a-z ]*'],
  ['Diakonie', 'diakonie[a-z ]*|brot fuer die welt'], ['DRK', 'drk(?: e v| blutspende| landesverband[a-z ]*)?|deutsches rotes kreuz|rotes kreuz'], ['Malteser', 'malteser[a-z ]*'], ['Johanniter', 'johanniter[a-z ]*'],
  ['Arbeiter-Samariter-Bund', 'arbeiter samariter[a-z ]*'], ['Welthungerhilfe', 'welthungerhilfe'], ['Misereor', 'misereor|adveniat|missio'], ['Aktion Mensch', 'aktion mensch|aktion deutschland hilft'],
  ['Deutsche Krebshilfe', 'deutsche krebshilfe|krebsgesellschaft|deutsche herzstiftung|deutsche aids hilfe|dkms'], ['Lebenshilfe', 'lebenshilfe|bethel|von bodelschwingh'],
  ['betterplace', 'betterplace(?: org)?|startnext|gofundme'], ['Tierschutz', 'tierschutz[a-z ]*|tierheim[a-z ]*|vier pfoten|ein herz fuer tiere|tierhilfe[a-z ]*'], ['Tafel', 'tafel e v|die tafeln|tafel[a-z ]*', { cpOnly: true }],
  ['Spendenkonto', 'spenden[a-z ]*|foerderverein[a-z ]*', { cpOnly: true, conf: 0.75 }],
]);
G('spenden', 'kirche', { conf: 0.8 }, [['Kirche', 'evangelische kirche[a-z ]*|katholische kirche[a-z ]*|ekd|kirchengemeinde[a-z ]*|kirchenkreis[a-z ]*|kirchgeld|kollekte|pfarramt|pfarrei[a-z ]*']]);

// ---------------------------------------------------------------- Gesundheit
G('gesundheit', 'apotheke', {}, [
  ['Apotheke', 'apotheke[a-z ]*|apotheken[a-z ]*|pharmacie'], ['DocMorris', 'doc ?morris'], ['Shop Apotheke', 'shop apotheke|redcare|mycare|aponeo|medpex|sanicare'],
  ['Sanitätshaus', 'sanitaetshaus[a-z ]*', { cpOnly: true }],
]);
G('gesundheit', 'brille', {}, [
  ['Fielmann', 'fielmann[a-z ]*'], ['Apollo-Optik', 'apollo ?optik|apollo'], ['Mister Spex', 'mister ?spex'], ['Optiker', 'optiker[a-z ]*|optik[a-z ]*|brille[a-z ]*|kontaktlinsen[a-z ]*|lensbest|lenstore', { cpOnly: true }],
  ['Hörgeräte', 'hoergeraete[a-z ]*|amplifon|geers|kind hoergeraete', { cpOnly: true }],
]);
G('gesundheit', 'zahnarzt', { cpOnly: true }, [['Zahnarzt', 'zahnarzt[a-z ]*|zahnaerzte[a-z ]*|zahnklinik|zahnmedizin[a-z ]*|kieferorthop[a-z ]*|dental[a-z ]*|dr med dent[a-z ]*']]);
G('gesundheit', 'arzt', { cpOnly: true, conf: 0.8 }, [
  ['Arzt', 'arzt[a-z ]*|aerzte[a-z ]*|praxis[a-z ]*|dr med[a-z ]*|physiotherap[a-z ]*|osteopath[a-z ]*|heilpraktiker[a-z ]*|psychotherap[a-z ]*|klinik[a-z ]*|krankenhaus[a-z ]*|uniklinik[a-z ]*|mvz[a-z ]*|augenarzt|hautarzt|frauenarzt|orthopaed[a-z ]*|radiolog[a-z ]*|kinderarzt|ergotherap[a-z ]*|logopaed[a-z ]*|asklepios|helios|sana kliniken|vivantes|charite|doctolib|teleclinic'],
]);

// ---------------------------------------------------------------- Beruf, Gewerkschaft, Bildung
G('beruf', 'gewerkschaft', { recurringHint: 'monthly' }, [
  ['ver.di', 'ver ?di(?: bundesverwaltung| mitgliedsbeitrag| bw| hamburg| bezirk[a-z ]*)?|vereinte dienstleistungsgewerkschaft'], ['IG Metall', 'ig metall[a-z ]*'], ['IG BCE', 'ig bce'], ['IG BAU', 'ig bau'],
  ['GEW', 'gew hauptvorstand|gew landesverband[a-z ]*|gewerkschaft erziehung[a-z ]*'], ['DGB', 'dgb|dbb beamtenbund|beamtenbund|marburger bund'], ['EVG', 'eisenbahn und verkehrsgewerkschaft|gdl|vereinigung cockpit'],
  ['Berufsverband', 'berufsverband[a-z ]*|aerztekammer|rechtsanwaltskammer|steuerberaterkammer|ingenieurkammer|architektenkammer|handwerkskammer|ihk|handelskammer', { cpOnly: true, conf: 0.75 }],
]);
G('beruf', 'kinderbetreuung', { cpOnly: true, conf: 0.8 }, [
  ['Kita', 'kita[a-z ]*|kindergarten[a-z ]*|kindertagesstaette[a-z ]*|kindertagespflege|tagesmutter|hort[a-z ]*|krippe[a-z ]*|kinderladen|elterninitiative|betreuungsgebuehr[a-z ]*|schulgeld[a-z ]*|schulverein|schulessen|offener ganztag'],
]);
G('beruf', 'fortbildung', { cpOnly: true, conf: 0.85 }, [
  ['Udemy', 'udemy|coursera|edx|linkedin learning|linkedin premium|skillshare|masterclass|domestika|pluralsight|datacamp|codecademy|openclassrooms|udacity'], ['Duolingo', 'duolingo|babbel|busuu|preply|italki|lingoda'],
  ['Akademie', 'akademie[a-z ]*|seminar[a-z ]*|fortbildung[a-z ]*|weiterbildung[a-z ]*|lehrgang[a-z ]*|schulung[a-z ]*|workshop[a-z ]*|fernstudium|fernuni[a-z ]*', { conf: 0.75 }],
  ['Hochschule', 'universitaet[a-z ]*|hochschule[a-z ]*|studierendenwerk|studentenwerk|semesterbeitrag|asta', { sub: 'schule', conf: 0.75 }],
]);
G('beruf', 'arbeitsmittel', { cpOnly: true, conf: 0.7 }, [
  ['Büro', 'buerobedarf[a-z ]*|buero[a-z ]*bedarf|staples|office discount|soennecken|printus|schreibwaren[a-z ]*|schulbedarf[a-z ]*|paperworld'],
]);

// ---------------------------------------------------------------- Steuern & Behörden
G('steuern_abgaben', 'einkommensteuer', { cpOnly: true, conf: 0.8 }, [
  ['Finanzamt', 'finanzamt[a-z ]*|finanzkasse[a-z ]*|bundeskasse|steueramt|oberfinanzdirektion|bundeszentralamt fuer steuern'],
  ['Steuerberater', 'steuerberater[a-z ]*|lohnsteuerhilfe[a-z ]*|wiso steuer|taxfix|smartsteuer|steuerkanzlei[a-z ]*', { sub: 'einkommensteuer' }],
]);
G('steuern_abgaben', 'kfz_steuer', { cpOnly: true, conf: 0.75 }, [
  ['Zoll (Kfz-Steuer)', 'hauptzollamt[a-z ]*|kfz ?steuer|zulassungsstelle[a-z ]*|strassenverkehrsamt|zulassungsdienst[a-z ]*'],
]);

// ---------------------------------------------------------------- Zahlungsdienstleister (Zwischenstationen)
G('sonstiges', 'unbekannt', { intermediary: true }, [
  ['PayPal', 'paypal[a-z ]*|pp \\d+ pp'], ['Klarna', 'klarna[a-z ]*|sofort(?:ueberweisung)?(?: gmbh)?|ratepay|billpay|afterpay|riverty'], ['SumUp', 'sum ?up(?: payments)?'],
  ['Stripe', 'stripe[a-z ]*'], ['Adyen', 'adyen[a-z ]*'], ['Zettle', 'zettle|izettle|square inc|payone|computop|mollie|unzer|heidelpay|worldline|concardis|nexi'],
]);

// ---------------------------------------------------------------- Banken, Broker, Vorsorge
G('vorsorge_sparen', 'sparplan_depot', { conf: 0.85 }, [
  ['Trade Republic', 'trade republic[a-z ]*'], ['Scalable Capital', 'scalable[a-z ]*'], ['Smartbroker', 'smartbroker[a-z ]*|justtrade|flatex[a-z ]*|degiro'], ['Consorsbank', 'consorsbank|consors'],
  ['onvista bank', 'onvista[a-z ]*|dab bank|c24 invest|nuri|growney|quirion|bevestor|easyfolio|moneyfarm|ginmon|whitebox'], ['Bitpanda', 'bitpanda|coinbase|kraken|bison|binance|bitcoin de'],
  ['Wertpapiersparplan', 'wertpapier[a-z ]*|etf sparplan[a-z ]*|fondssparplan[a-z ]*|depot(?:bank|uebertrag|ueberweisung)[a-z ]*|comdirect depot[a-z ]*|ing depot|dkb depot|dkb broker', { cpOnly: true }],
]);
G('vorsorge_sparen', 'tagesgeld', { conf: 0.8 }, [
  ['Renault Bank', 'renault bank(?: direkt)?'], ['Tagesgeld', 'tagesgeld[a-z ]*|festgeld[a-z ]*|sparkonto[a-z ]*|extra konto', { cpOnly: true }], ['Weltsparen', 'weltsparen|raisin|zinspilot'],
  ['VW Bank direkt', 'vw bank direkt|volkswagen bank direkt|bmw bank|mercedes benz bank|bank norwegian|bunq'],
]);
G('vorsorge_sparen', 'bausparen', { recurringHint: 'monthly' }, [
  ['Schwäbisch Hall', 'schwaebisch hall'], ['Wüstenrot', 'wuestenrot'], ['BHW', 'bhw(?: bausparkasse)?'], ['LBS', 'lbs(?: bausparkasse| west| nord| sued| ost| hessen)?'],
  ['Bausparkasse', 'bausparkasse[a-z ]*|bausparvertrag|bauspar[a-z ]*|aachener bausparkasse|badenia', { cpOnly: true }],
]);
G('vorsorge_sparen', 'privatrente', { conf: 0.7, cpOnly: true }, [['Altersvorsorge', 'privatrente|riester|ruerup|basisrente|altersvorsorge|fondspolice|pensionskasse|versorgungswerk|direktversicherung|betriebsrente']]);
G('finanzen', 'kredit', { cpOnly: true, conf: 0.75 }, [
  ['Kredit', 'kreditrate|darlehen[a-z ]*|ratenkredit|autokredit|finanzierung[a-z ]*|kfw|easycredit|teambank|smava|auxmoney|creditplus|cetelem|consorsfinanz|ikano bank|santander consumer[a-z ]*|vw financial services|toyota kreditbank|ford bank|opel bank|audi bank|cofidis|baufinanzierung[a-z ]*|hypothek[a-z ]*|interhyp|dr klein'],
]);
// Banken als Gegenpartei: nur schwacher Hinweis (Stichwortregeln gehen vor)
G('finanzen', 'kontofuehrung', { cpOnly: true, conf: 0.5 }, [
  ['ING', 'ing(?: diba| bank| deutschland)?'], ['comdirect', 'comdirect(?: bank)?'], ['DKB', 'dkb|deutsche kreditbank'], ['Commerzbank', 'commerzbank'], ['Deutsche Bank', 'deutsche bank'],
  ['Postbank', 'postbank|norisbank'], ['HypoVereinsbank', 'hypovereinsbank|unicredit'], ['Targobank', 'targobank'], ['Santander', 'santander'], ['Sparkasse', 'sparkasse[a-z ]*|haspa|hamburger sparkasse'],
  ['Volksbank', 'volksbank[a-z ]*|raiffeisenbank[a-z ]*|sparda[a-z ]*|psd bank[a-z ]*|gls bank|apobank|bbbank'], ['N26', 'n26|revolut|c24|wise(?: payments| europe)?|transferwise'],
  ['Kreditkarte', 'barclays[a-z ]*|american express|amex|advanzia|visa card|kreditkarte[a-z ]*'],
]);

// ---------------------------------------------------------------- Index (Wortanfänge → Kandidaten)
// Pro Muster-Alternative wird das feste Wortpräfix bestimmt; nur Händler mit passendem Präfix im Text werden geprüft.
function splitTop(src) {
  const out = []; let depth = 0, cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { cur += c + (src[++i] || ''); continue; }
    if (c === '[') { const j = src.indexOf(']', i); cur += src.slice(i, j + 1); i = j; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
function anchorOf(alt) {
  let lit = '';
  for (let i = 0; i < alt.length; i++) {
    const c = alt[i];
    if ('\\^$.|()[]{}?*+'.includes(c)) {
      if (c === '+' && i === 0) return '';
      break;
    }
    const n = alt[i + 1];
    if (n && '?*+{'.includes(n)) break;
    lit += c;
  }
  return lit.split(' ')[0];
}
const INDEX = new Map();
const ALWAYS = [];
LIST.forEach((m, i) => {
  let always = false;
  const anchors = new Set();
  for (const alt of splitTop(m.src)) { const a = anchorOf(alt); if (!a) always = true; else anchors.add(a); }
  if (always) ALWAYS.push(i);
  for (const a of anchors) { if (!INDEX.has(a)) INDEX.set(a, []); INDEX.get(a).push(i); }
});

function candidates(text) {
  const set = new Set(ALWAYS);
  for (const w of text.split(' ')) {
    const max = Math.min(w.length, 20);
    for (let l = 1; l <= max; l++) { const hit = INDEX.get(w.slice(0, l)); if (hit) for (const i of hit) set.add(i); }
  }
  return [...set].sort((a, b) => a - b);
}

export const MERCHANTS = LIST;

/**
 * Erster passender Händler (in Listenreihenfolge).
 * @param {string} cpText gefaltete Gegenpartei (Name/Raw)
 * @param {string} purposeText gefalteter Verwendungszweck/Buchungstext
 */
export function findMerchant(cpText, purposeText = '') {
  if (cpText) for (const i of candidates(cpText)) if (LIST[i].re.test(cpText)) return LIST[i];
  if (purposeText) for (const i of candidates(purposeText)) if (!LIST[i].cpOnly && LIST[i].re.test(purposeText)) return LIST[i];
  return null;
}
