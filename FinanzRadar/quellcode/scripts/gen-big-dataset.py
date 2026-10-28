# Großer synthetischer Datensatz für Import-Belastungstests (nur Entwicklung, nicht Teil der App):
#   python3 scripts/gen-big-dataset.py [/tmp/fr-big]
# ~6.000 ING-Buchungen (3 Jahre), 300 PDF-Rechnungen, 50 Bon-Bilder, kaputte/verschlüsselte/leere Dateien, Zip, lange Namen,
# Umlaute/Leerzeichen, 6 Ebenen tief, Dubletten in mehreren Ordnern. Braucht reportlab, Pillow, qpdf.
# Browser-Tests mit Umlaut-Pfaden: Playwright mit LC_ALL=C.UTF-8 starten (sonst kann Chromium die Dateien nicht lesen).
import os, sys, random, shutil, subprocess, datetime, zipfile, io
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw, ImageFont
random.seed(42)
ROOT=sys.argv[1] if len(sys.argv) > 1 else '/tmp/fr-big'
shutil.rmtree(ROOT, ignore_errors=True)
S=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'samples', 'out')
def mk(p): os.makedirs(os.path.dirname(p), exist_ok=True); return p
def de(c): 
    s=f"{abs(c)/100:,.2f}".replace(',','X').replace('.',',').replace('X','.')
    return ('-' if c<0 else '')+s

# ---- 1. big ING CSV (3 years, ~6000 rows) ----
merchants=[('REWE Markt','Kartenzahlung','VISA Debitkarte NR XXXX HAMBURG KAUFUMSATZ',(-1200,-9000)),
('Edeka Center','Kartenzahlung','VISA Debitkarte NR XXXX HAMBURG KAUFUMSATZ',(-500,-7000)),
('Penny Markt','Kartenzahlung','VISA Debitkarte NR XXXX HAMBURG KAUFUMSATZ',(-300,-4000)),
('Tankstelle Shell','Kartenzahlung','VISA Debitkarte NR XXXX HAMBURG KAUFUMSATZ',(-2500,-8000)),
('Amazon EU S.a.r.l.','Lastschrift','Amazon.de Bestellung 302-1234567-1234567',(-800,-15000)),
('Lieferando','Lastschrift','Bestellung Lieferando',(-1500,-4500)),
('dm-drogerie markt','Kartenzahlung','VISA Debitkarte KAUFUMSATZ',(-400,-5000)),
('Geldautomat Hamburg','Auszahlung Geldautomat','Bargeldauszahlung',(-2000,-20000)),
('Deutsche Bahn','Kartenzahlung','Fahrkarte',(-1500,-12000)),
('Apotheke am Markt','Kartenzahlung','VISA Debitkarte',(-500,-6000)),
('Kino Cinemaxx','Kartenzahlung','VISA Debitkarte',(-900,-3000)),
('Bäckerei Müller','Kartenzahlung','VISA Debitkarte',(-200,-1500))]
monthly=[('Vermieter Schmidt Immobilien','Dauerauftrag/Terminüberw.','Miete Wohnung',-95000,1),
('Vattenfall Europe Sales GmbH','Lastschrift','Abschlag Strom Kd.-Nr. 5009123',-8450,12),
('Telekom Deutschland GmbH','Lastschrift','Rechnung Kd.-Nr. 88310042',-4995,15),
('Netflix International B.V.','Lastschrift','Netflix Abo',-1799,5),
('Spotify AB','Lastschrift','Spotify Premium',-1099,7),
('Alte Leipziger Versicherung AG','Lastschrift','BU-Vertrag 55-778899 Beitrag',-6230,10),
('HUK-COBURG','Lastschrift','Kfz-Versicherung Beitrag',-7480,3),
('Fitnessstudio FitX','Lastschrift','Mitgliedsbeitrag',-2490,2)]
rows=[]
d0=datetime.date(2023,7,1); d1=datetime.date(2026,6,30)
d=d0
while d<=d1:
    if d.day==26: rows.append((d,'Frigotechnik GmbH','Eingang',f'Gehalt {d:%m/%Y}',329098))
    for m in monthly:
        if d.day==m[4]: rows.append((d,m[0],m[1],m[2]+f' {d:%m/%Y}',m[3]))
    d+=datetime.timedelta(1)
n=6000-len(rows)
span=(d1-d0).days
for i in range(n):
    m=random.choice(merchants)
    dd=d0+datetime.timedelta(random.randint(0,span))
    rows.append((dd,m[0],m[1],m[2]+f' {dd:%d.%m} #{i}',random.randint(-m[3][0],-m[3][1])*-1 if False else -random.randint(-m[3][0],-m[3][1]) if m[3][0]>m[3][1] else random.randint(m[3][0],m[3][1])))
rows.sort(key=lambda r:r[0])
bal=250000
out=[]
for r in rows:
    bal+=r[4]
    out.append((r,bal))
bal_final=bal
lines=['Umsatzanzeige;Datei erstellt am: 30.06.2026 10:15','','IBAN;DE12 5001 0517 0000 0000 01','Kontoname;Girokonto','Bank;ING','Kunde;Max Mustermann','Zeitraum;01.07.2023 - 30.06.2026',f'Saldo;{de(bal_final)};EUR','','Buchung;Wertstellungsdatum;Auftraggeber/Empfänger;Buchungstext;Verwendungszweck;Saldo;Währung;Betrag;Währung']
for r,b in reversed(out):
    lines.append(f"{r[0]:%d.%m.%Y};{r[0]:%d.%m.%Y};{r[1]};{r[2]};{r[3]};{de(b)};EUR;{de(r[4])};EUR")
with open(mk(f'{ROOT}/Konten und Bank/ING Girokonto/Jahre 2023-2026/ing_umsatz_gesamt.csv'),'wb') as f:
    f.write(('\r\n'.join(lines)+'\r\n').encode('cp1252'))
print('csv rows',len(out))

# ---- 2. 300 PDFs (invoices) ----
vendors=['Elektro Meyer GmbH','Amazon EU S.a.r.l.','Sanitär Böhm','Zahnarztpraxis Dr. Köhler','Telekom Deutschland GmbH','Stadtwerke Hamburg','Möbelhaus Krüger','Autohaus Nord','Buchhandlung Lesezeit','Optik Sehstark']
def invoice(path, i):
    c=canvas.Canvas(mk(path), pagesize=A4)
    v=random.choice(vendors); dt=d0+datetime.timedelta(random.randint(0,span))
    net=random.randint(1500,150000); vat=round(net*0.19); gross=net+vat
    c.setFont('Helvetica-Bold',16); c.drawString(50,780,v)
    c.setFont('Helvetica',10); c.drawString(50,760,'Musterstraße 12, 20095 Hamburg')
    c.setFont('Helvetica-Bold',14); c.drawString(50,720,'Rechnung')
    c.setFont('Helvetica',10)
    c.drawString(50,700,f'Rechnungsnummer: RE-{dt.year}-{i:05d}')
    c.drawString(50,686,f'Rechnungsdatum: {dt:%d.%m.%Y}')
    c.drawString(50,672,'Kunde: Max Mustermann, Beispielweg 3, 22083 Hamburg')
    y=640
    for k in range(random.randint(2,8)):
        c.drawString(50,y,f'Position {k+1} Artikel {random.randint(100,999)} Leistung'); c.drawRightString(500,y,de(random.randint(500,20000))+' EUR'); y-=14
    y-=10
    c.drawString(300,y,'Nettobetrag'); c.drawRightString(500,y,de(net)+' EUR'); y-=14
    c.drawString(300,y,'MwSt 19 %'); c.drawRightString(500,y,de(vat)+' EUR'); y-=14
    c.setFont('Helvetica-Bold',11); c.drawString(300,y,'Gesamtbetrag'); c.drawRightString(500,y,de(gross)+' EUR'); y-=24
    c.setFont('Helvetica',9); c.drawString(50,y,f'Zahlbar innerhalb von 14 Tagen. IBAN DE89 3704 0044 0532 0130 00 Unique-{i}-{random.random()}')
    c.showPage(); c.save()
dirs=['Belege/2023','Belege/2024','Belege/2025','Belege/2026/Q1','Belege/Handwerker/Rechnungen/Eingang/Archiv/Alt','Steuer/Unterlagen für das Finanzamt/Ä Ö Ü test']
for i in range(300):
    dr=random.choice(dirs)
    invoice(f'{ROOT}/{dr}/Rechnung {i:03d} Müller & Söhne.pdf', i)
print('pdfs done')

# ---- 3. 50 receipt images ----
try: font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',22)
except: font=ImageFont.load_default()
for i in range(50):
    if i<20:
        src=random.choice([f'{S}/Belege/kassenbon_edeka_2026-05-03.jpg',f'{S}/Belege/kassenbon_rewe_2026-04-12.png'])
        im=Image.open(src).convert('RGB')
        px=im.load(); 
        for _ in range(50): px[random.randrange(im.width),random.randrange(im.height)]=(random.randint(0,255),)*3
        ext='jpg' if src.endswith('jpg') else 'png'
        im.save(mk(f'{ROOT}/Kassenbons/bon_kopie_{i:02d}.{ext}'), quality=90) if ext=='jpg' else im.save(mk(f'{ROOT}/Kassenbons/bon_kopie_{i:02d}.{ext}'))
    else:
        im=Image.new('RGB',(480,700),'white'); dr=ImageDraw.Draw(im)
        t=['REWE Markt GmbH','Musterstr. 1','20095 Hamburg','',f'Datum: {random.randint(1,28):02d}.{random.randint(1,12):02d}.2025','']
        tot=0
        for k in range(random.randint(5,14)):
            p=random.randint(49,1299); tot+=p; t.append(f'Artikel {random.randint(10,99)}'.ljust(24)+de(p).rjust(8)+' B')
        t+=['','SUMME EUR'.ljust(24)+de(tot).rjust(8),'Vielen Dank!']
        for k,l in enumerate(t): dr.text((20,20+k*30),l,fill='black',font=font)
        im.save(f'{ROOT}/Kassenbons/Bon neu {i:02d}.png')

# ---- 4. broken stuff ----
B=f'{ROOT}/Kaputt'
mk(B+'/x')
open(B+'/leer.pdf','wb').close()
open(B+'/leer.txt','wb').close()
open(B+'/leer.csv','wb').close()
open(B+'/leer.png','wb').close()
open(B+'/zufall.pdf','wb').write(os.urandom(5000))
good=open(f'{S}/Belege/rechnung_elektro_meyer_2026-02.pdf','rb').read()
open(B+'/abgeschnitten.pdf','wb').write(good[:len(good)//2])
open(B+'/nur_header.pdf','wb').write(b'%PDF-1.4\n')
subprocess.run(['qpdf','--encrypt','geheim','geheim','256','--',f'{S}/Belege/rechnung_amazon_monitor_2026-04.pdf',B+'/verschluesselt.pdf'])
open(B+'/zufall.png','wb').write(os.urandom(3000))
open(B+'/kaputt.jpg','wb').write(b'\xff\xd8\xff\xe0'+os.urandom(2000))
open(B+'/kaputt.xlsx','wb').write(os.urandom(4000))
open(B+'/kaputt.xml','wb').write(b'<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt><Ntry>')
open(B+'/binaer.csv','wb').write(os.urandom(20000))
open(B+'/binaer.txt','wb').write(os.urandom(20000))
open(B+'/riesig.txt','w').write('Lorem ipsum Rechnung Betrag 12,00 EUR\n'*200000)  # ~7.6MB
open(B+'/kaputt.heic','wb').write(os.urandom(5000))
open(B+'/kaputt.tiff','wb').write(os.urandom(5000))
# zip
with zipfile.ZipFile(B+'/archiv.zip','w') as z: z.writestr('a.txt','hi')
# pdf that is actually png
shutil.copy(f'{S}/Belege/kassenbon_rewe_2026-04-12.png', B+'/ist_in_wahrheit_png.pdf')
# long filenames
L='/'.join(['lang']*0)
long='A'*120+' sehr langer Dateiname mit Umlauten äöüß und Leerzeichen '+'B'*60
shutil.copy(f'{S}/Belege/rechnung_elektro_meyer_2026-02.pdf', mk(f'{ROOT}/Lang/{long}.pdf'))
deepdir='/'.join(f'Ebene {k} Ünïcödé' for k in range(1,7))
shutil.copy(f'{S}/Belege/rechnung_amazon_monitor_2026-04.pdf', mk(f'{ROOT}/Tief/{deepdir}/tiefe rechnung.pdf'))
# duplicates in different folders
for k,dd in enumerate(['Dubletten/A','Dubletten/B/c','Archiv 2025/Kopie von','Tief/Ebene 1 Ünïcödé']):
    shutil.copy(f'{S}/Belege/rechnung_elektro_meyer_2026-02.pdf', mk(f'{ROOT}/{dd}/elektro_{k}.pdf'))
    shutil.copy(f'{S}/Banken/ING/ing_kontoauszug_2026-03.pdf', mk(f'{ROOT}/{dd}/ing_auszug_{k}.pdf'))
# a few real samples
shutil.copytree(S, f'{ROOT}/Beispiele', dirs_exist_ok=True)
