# Minimaler statischer Webserver für FinanzRadar (nur localhost), ohne Installation.
# Dazu die Outlook-Brücke unter /api/outlook/* für das klassische Outlook (Desktop, COM).
# „Neues Outlook“ hat keine COM-Schnittstelle – dann meldet /api/outlook/status available=false mit Grund.
# Läuft mit Windows PowerShell 5.1 und PowerShell 7 (Datei muss UTF-8 MIT BOM bleiben, sonst liest 5.1 die Umlaute falsch).
$port = 8765
$root = Join-Path $PSScriptRoot 'app'
$rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\')
$rootPrefix = $rootFull + '\'
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript'; '.mjs'='text/javascript'; '.css'='text/css'; '.json'='application/json'; '.svg'='image/svg+xml'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.gif'='image/gif'; '.webp'='image/webp'; '.heic'='image/heic'; '.tif'='image/tiff'; '.tiff'='image/tiff'; '.wasm'='application/wasm'; '.gz'='application/gzip'; '.pdf'='application/pdf'; '.csv'='text/csv'; '.xml'='application/xml'; '.txt'='text/plain; charset=utf-8'; '.xlsx'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; '.xls'='application/vnd.ms-excel'; '.pfb'='application/octet-stream'; '.ttf'='font/ttf'; '.msg'='application/vnd.ms-outlook' }
$allowedHosts = @("localhost:$port", "127.0.0.1:$port")
$utf8 = New-Object System.Text.UTF8Encoding($false)
$inv = [Globalization.CultureInfo]::InvariantCulture

if (-not (Test-Path -LiteralPath (Join-Path $root 'index.html') -PathType Leaf)) {
  Write-Host "Warnung: App-Ordner fehlt oder ist unvollstaendig: $root"
}

# Nur das Präfix "localhost" registrieren: das darf jeder Benutzer ohne Administratorrechte (urlacl).
# Anfragen mit Host 127.0.0.1 weist http.sys damit bereits selbst ab; die App wird über localhost geöffnet.
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try {
  $listener.Start()
} catch {
  Write-Host "FinanzRadar konnte Port $port nicht oeffnen: $($_.Exception.Message)"
  Write-Host "Laeuft FinanzRadar bereits in einem anderen Fenster? Der Browser wird trotzdem geoeffnet."
  try { Start-Process "http://localhost:$port/" } catch { }
  exit 1
}
Write-Host "FinanzRadar laeuft auf http://localhost:$port/  (Fenster offen lassen, Beenden mit Fenster schliessen)"
try { Start-Process "http://localhost:$port/" } catch { Write-Host "Browser bitte selbst oeffnen: http://localhost:$port/" }

# ---- Outlook-Zugriff: läuft je Anfrage in eigenem STA-Runspace, damit ein Zeitlimit greifen kann ----
# Ergebnis immer als Hashtable: @{ status; json } | @{ status; text } | @{ status; bytes; name } | @{ status; error }
$outlookWorker = {
  param($cmd, $a)
  $ErrorActionPreference = 'Stop'
  $inv = [Globalization.CultureInfo]::InvariantCulture
  function Fail($status, $msg) { throw ("FR{0}|{1}" -f $status, $msg) }
  function Release($o) {
    # COM-Referenzen sofort freigeben (Exchange-Online-Modus erlaubt nur begrenzt viele offene Elemente)
    if ($null -ne $o) { try { if ([Runtime.InteropServices.Marshal]::IsComObject($o)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } } catch { } }
  }
  function IsoDate($d) { ([datetime]$d).ToString("yyyy-MM-dd'T'HH:mm:ss", $inv) }   # Ortszeit ohne Zone (wie Mac-Variante)
  function Split-Id($id) {
    $p = ([string]$id).Split('.')
    if ($p.Count -eq 2) { return ,$p } else { return ,@($p[0], $null) }
  }
  function Get-Message($ns, $id) {
    $p = Split-Id $id
    $m = $null
    try { if ($p[1]) { $m = $ns.GetItemFromID($p[0], $p[1]) } else { $m = $ns.GetItemFromID($p[0]) } } catch { Fail 404 'Mail nicht gefunden (gelöscht oder verschoben?)' }
    if ($null -eq $m) { Fail 404 'Mail nicht gefunden (gelöscht oder verschoben?)' }
    return $m
  }
  function Sender-Text($m) {
    $name = [string]$m.SenderName
    $addr = ''
    try {
      if ([string]$m.SenderEmailType -eq 'EX') {
        $s = $m.Sender
        $xu = $null
        if ($null -ne $s) { $xu = $s.GetExchangeUser() }
        if ($null -ne $xu) { $addr = [string]$xu.PrimarySmtpAddress }
        Release $xu; Release $s
      } else { $addr = [string]$m.SenderEmailAddress }
    } catch { }
    if ($addr -and $name -and $addr -ne $name) { return "$name <$addr>" }
    if ($addr) { return $addr }
    return $name
  }
  # Anhangsname wie er gelistet und beim Abruf verwendet wird; $null = nicht speicherbar
  # (olByReference = 4: nur Verknüpfung, olOLE = 6: eingebettetes OLE-Objekt). olEmbeddeditem = 5 wird als .msg gespeichert.
  function Att-Name($at, $i) {
    $type = 1
    try { $type = [int]$at.Type } catch { }
    if ($type -eq 4 -or $type -eq 6) { return $null }
    $n = ''
    try { $n = [string]$at.FileName } catch { }
    if (-not $n) { try { $n = [string]$at.DisplayName } catch { } }
    if (-not $n) { $n = "Anhang$i" }
    if ($type -eq 5 -and $n -notmatch '\.msg$') { $n += '.msg' }
    return $n
  }

  $ol = $null; $ns = $null
  try {
    try { $ol = New-Object -ComObject Outlook.Application } catch { throw }
    $ns = $ol.GetNamespace('MAPI')
    switch ($cmd) {
      'folders' {
        $inboxId = ''; $inboxName = ''
        try { $ib = $ns.GetDefaultFolder(6); $inboxId = [string]$ib.EntryID; $inboxName = [string]$ib.Name; Release $ib } catch { }
        $out = New-Object System.Collections.ArrayList
        function Walk($folders, $prefix, $depth) {
          if ($depth -gt 12) { return }
          foreach ($f in $folders) {
            try {
              # Öffentliche Ordner (olExchangePublicFolder = 2) auslassen – riesig und langsam
              $skip = $false
              if ($depth -eq 0) { try { $st = $f.Store; if ([int]$st.ExchangeStoreType -eq 2) { $skip = $true }; Release $st } catch { } }
              if (-not $skip -and [int]$f.DefaultItemType -eq 0) {   # nur Mail-Ordner (olMailItem)
                $name = [string]$f.Name
                $path = $prefix + $name
                $eid = [string]$f.EntryID
                $count = 0
                try { $its = $f.Items; $count = [int]$its.Count; Release $its } catch { }
                $isInbox = ($inboxId -and $eid -eq $inboxId)
                if (-not $isInbox -and $inboxId -and $name -eq $inboxName) { try { $isInbox = [bool]$ns.CompareEntryIDs($eid, $inboxId) } catch { } }
                [void]$out.Add([pscustomobject]@{ id = ($eid + '.' + [string]$f.StoreID); name = $name; path = $path; count = $count; inbox = [bool]$isInbox })
                $sub = $f.Folders
                Walk $sub ($path + '/') ($depth + 1)
                Release $sub
              }
            } catch { }
            Release $f
          }
        }
        $top = $ns.Folders
        Walk $top '' 0
        Release $top
        return @{ status = 200; json = $out }
      }
      'messages' {
        $p = Split-Id $a.folder
        $f = $null
        try { if ($p[1]) { $f = $ns.GetFolderFromID($p[0], $p[1]) } else { $f = $ns.GetFolderFromID($p[0]) } } catch { Fail 404 'Ordner nicht gefunden' }
        if ($null -eq $f) { Fail 404 'Ordner nicht gefunden' }
        $store = [string]$f.StoreID
        $since = [datetime]::ParseExact([string]$a.since, 'yyyy-MM-dd', $inv)
        $limit = [int]$a.limit
        # Kein Items.Restrict: dessen Datumsformat hängt von der Systemsprache ab. Stattdessen absteigend nach
        # Empfangszeit sortieren und beim ersten älteren Element aufhören (ReceivedTime ist Ortszeit, $since auch).
        $items = $f.Items
        $items.Sort('[ReceivedTime]', $true)
        $out = New-Object System.Collections.ArrayList
        $m = $items.GetFirst()
        while ($null -ne $m -and $out.Count -lt $limit) {
          $stop = $false
          try {
            if ([int]$m.Class -eq 43) {   # nur E-Mails (olMail)
              $rt = [datetime]$m.ReceivedTime
              if ($rt -lt $since) { $stop = $true }
              elseif ($rt.Year -lt 4500) {   # 01.01.4501 = „kein Datum“ (z. B. Entwürfe)
                $atts = New-Object System.Collections.ArrayList
                $col = $m.Attachments
                $n = [int]$col.Count
                for ($i = 1; $i -le $n; $i++) {
                  $at = $null
                  try {
                    $at = $col.Item($i)
                    $aname = Att-Name $at $i
                    if ($null -ne $aname) {
                      $size = $null
                      try { $size = [int64]$at.Size } catch { }
                      [void]$atts.Add([pscustomobject]@{ index = $i; name = $aname; size = $size })
                    }
                  } catch { }
                  Release $at
                }
                Release $col
                [void]$out.Add([pscustomobject]@{ id = ([string]$m.EntryID + '.' + $store); subject = [string]$m.Subject; from = (Sender-Text $m); date = (IsoDate $rt); hasBody = $true; attachments = [object[]]$atts.ToArray() })
              }
            }
          } catch { }
          Release $m
          $m = $null
          if ($stop) { break }
          $m = $items.GetNext()
        }
        Release $m; Release $items; Release $f
        return @{ status = 200; json = $out }
      }
      'body' {
        $m = Get-Message $ns $a.id
        $text = [string]$m.Body
        $head = "Von: " + (Sender-Text $m) + "`nBetreff: " + [string]$m.Subject + "`nDatum: " + ([datetime]$m.ReceivedTime).ToString('dd.MM.yyyy HH:mm', $inv)
        Release $m
        return @{ status = 200; text = ($head + "`n`n" + ($text -replace "`r`n?", "`n").Trim()) }
      }
      'attachment' {
        $m = Get-Message $ns $a.id
        $col = $m.Attachments
        if ($a.index -gt [int]$col.Count) { Fail 404 'Anhang nicht gefunden' }
        $at = $col.Item($a.index)
        $name = Att-Name $at $a.index
        if ($null -eq $name) { Fail 404 'Anhang ist nur eine Verknüpfung bzw. ein OLE-Objekt und kann nicht gespeichert werden' }
        $safe = ($name -replace '[\\/:*?"<>|\x00-\x1f]', '_').Trim('. ')
        if (-not $safe) { $safe = "Anhang$($a.index)" }
        if ($safe.Length -gt 100) {   # MAX_PATH im Temp-Ordner nicht überschreiten
          $ext = [IO.Path]::GetExtension($safe)
          if ($ext.Length -gt 12) { $ext = '' }
          $safe = $safe.Substring(0, 100 - $ext.Length).TrimEnd('. ') + $ext
        }
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('finanzradar-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($tmp)
        try {
          $dest = Join-Path $tmp $safe
          try { $at.SaveAsFile($dest) } catch { Fail 502 ('Outlook konnte den Anhang nicht speichern: ' + $_.Exception.Message) }
          if (-not [IO.File]::Exists($dest)) { Fail 502 'Outlook hat den Anhang nicht gespeichert.' }
          $bytes = [IO.File]::ReadAllBytes($dest)
        } finally {
          try { [IO.Directory]::Delete($tmp, $true) } catch { }
        }
        Release $at; Release $col; Release $m
        return @{ status = 200; bytes = $bytes; name = $name }
      }
      default { Fail 404 'Unbekannter Endpunkt' }
    }
  } catch {
    $msg = [string]$_.Exception.Message
    if ($msg -match '^FR(\d{3})\|(.*)$') { return @{ status = [int]$Matches[1]; error = $Matches[2] } }
    $e = $_.Exception
    $hr = $e.HResult
    if ($null -ne $e.InnerException) { $hr2 = $e.InnerException.HResult } else { $hr2 = $hr }
    if ($hr -eq -2147221164 -or $hr2 -eq -2147221164 -or $msg -match '80040154|REGDB_E_CLASSNOTREG') { return @{ status = 503; error = 'Klassisches Outlook ist nicht installiert („Neues Outlook“ unterstützt keine Anbindung).' } }
    if ($hr -eq -2146959355 -or $hr2 -eq -2146959355 -or $msg -match '80080005|CO_E_SERVER_EXEC_FAILURE') { return @{ status = 503; error = 'Outlook und FinanzRadar laufen mit unterschiedlichen Rechten – beide normal (nicht als Administrator) starten.' } }
    return @{ status = 502; error = ('Outlook-Fehler: ' + $msg) }
  } finally {
    # Outlook NICHT beenden (gehört dem Benutzer), nur unsere Referenzen lösen
    Release $ns; Release $ol
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
}

function Send-Bytes($ctx, [int]$status, [byte[]]$bytes, [string]$type) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.Headers['X-Content-Type-Options'] = 'nosniff'
  if ($null -eq $bytes) { $bytes = [byte[]]@() }
  $res.ContentLength64 = $bytes.Length
  if ($bytes.Length -and $ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
}
function Send-Json($ctx, [int]$status, $obj) {
  # -InputObject statt Pipeline: Arrays mit 0/1 Element bleiben JSON-Arrays
  Send-Bytes $ctx $status $utf8.GetBytes((ConvertTo-Json -InputObject $obj -Depth 6 -Compress)) 'application/json; charset=utf-8'
}
function Send-Text($ctx, [int]$status, [string]$text) {
  Send-Bytes $ctx $status $utf8.GetBytes($text) 'text/plain; charset=utf-8'
}

function Test-OutlookInstalled {
  try { return [bool](Test-Path -LiteralPath 'Registry::HKEY_CLASSES_ROOT\Outlook.Application\CLSID') } catch { return $false }
}

# Runspaces, die nach Zeitüberschreitung noch in einem Outlook-Aufruf hängen; werden später aufgeräumt
$abandoned = New-Object System.Collections.ArrayList

function Invoke-Outlook([string]$cmd, [hashtable]$a, [int]$timeoutSec) {
  foreach ($old in @($abandoned)) {
    if ($old.Handle.IsCompleted) {
      try { $old.PS.Dispose(); $old.RS.Dispose() } catch { }
      $abandoned.Remove($old)
    }
  }
  $rs = [RunspaceFactory]::CreateRunspace()
  $rs.ApartmentState = [Threading.ApartmentState]::STA   # Outlook-COM gehört in einen STA-Thread
  $rs.ThreadOptions = [Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
  $rs.Open()
  $ps = [PowerShell]::Create()
  $ps.Runspace = $rs
  [void]$ps.AddScript($outlookWorker.ToString()).AddArgument($cmd).AddArgument($a)
  $h = $ps.BeginInvoke()
  if (-not $h.AsyncWaitHandle.WaitOne($timeoutSec * 1000)) {
    try { [void]$ps.BeginStop($null, $null) } catch { }   # Runspace bleibt ggf. hängen – Antwort trotzdem sofort
    [void]$abandoned.Add([pscustomobject]@{ PS = $ps; RS = $rs; Handle = $h })
    return @{ status = 504; error = 'Outlook antwortet nicht (Zeitlimit überschritten). Wartet Outlook auf eine Bestätigung (Sicherheitsabfrage)?' }
  }
  try {
    $out = $ps.EndInvoke($h)
    if ($out.Count -gt 0) {
      $last = $out[$out.Count - 1]
      if ($null -ne $last -and $last.psobject.BaseObject -is [hashtable]) { return $last.psobject.BaseObject }
    }
    if ($ps.Streams.Error.Count) { $err = [string]$ps.Streams.Error[0] } else { $err = 'keine Antwort' }
    return @{ status = 502; error = ('Outlook-Fehler: ' + $err) }
  } catch {
    return @{ status = 502; error = ('Outlook-Fehler: ' + $_.Exception.Message) }
  } finally {
    $ps.Dispose()
    $rs.Dispose()
  }
}

function Handle-Api($ctx) {
  $req = $ctx.Request
  if ($req.HttpMethod -ne 'GET') { Send-Json $ctx 405 @{ error = 'Nur GET' }; return }
  # Nur die eigene Seite darf fragen (keine CORS-Header; zusätzlich Fetch-Metadaten/Origin prüfen)
  $site = [string]$req.Headers['Sec-Fetch-Site']
  $origin = [string]$req.Headers['Origin']
  $originOk = $true
  if ($origin) { $originOk = $allowedHosts -contains ($origin.ToLower() -replace '^http://', '') -and $origin.ToLower().StartsWith('http://') }
  if (($site -and $site -ne 'same-origin' -and $site -ne 'none') -or -not $originOk) {
    Send-Json $ctx 403 @{ error = 'Nur von FinanzRadar selbst erlaubt' }; return
  }
  $q = $req.QueryString
  # Outlook-IDs: EntryID (hex) + '.' + StoreID (hex); StoreIDs von Exchange-Postfächern können lang sein
  $idRe = '^[0-9A-Fa-f]{2,1024}(\.[0-9A-Fa-f]{2,8192})?$'
  $route = $req.Url.AbsolutePath
  if ($route -ceq '/api/outlook/status') {
    if (Test-OutlookInstalled) { Send-Json $ctx 200 @{ available = $true; platform = 'windows' } }
    else { Send-Json $ctx 200 @{ available = $false; platform = 'windows'; reason = 'Klassisches Outlook ist nicht installiert („Neues Outlook“ unterstützt keine Anbindung).' } }
    return
  }
  $r = $null
  if ($route -ceq '/api/outlook/folders') {
    $r = Invoke-Outlook 'folders' @{} 120
  } elseif ($route -ceq '/api/outlook/messages') {
    $folder = [string]$q['folder']; $since = [string]$q['since']; $limit = [string]$q['limit']
    if ($folder -notmatch $idRe) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: folder' }; return }
    if (-not $since) { $since = (Get-Date).AddYears(-1).ToString('yyyy-MM-dd', $inv) }
    $d = [datetime]::MinValue
    if ($since -notmatch '^\d{4}-\d{2}-\d{2}$' -or -not [datetime]::TryParseExact($since, 'yyyy-MM-dd', $inv, [Globalization.DateTimeStyles]::None, [ref]$d)) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: since' }; return }
    if ($null -eq $q['limit']) { $limit = '500' }
    if ($limit -notmatch '^\d{1,6}$' -or [int]$limit -lt 1 -or [int]$limit -gt 5000) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: limit' }; return }
    $r = Invoke-Outlook 'messages' @{ folder = $folder; since = $since; limit = [int]$limit } 180
  } elseif ($route -ceq '/api/outlook/body') {
    $id = [string]$q['id']
    if ($id -notmatch $idRe) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: id' }; return }
    $r = Invoke-Outlook 'body' @{ id = $id } 60
  } elseif ($route -ceq '/api/outlook/attachment') {
    $id = [string]$q['id']; $index = [string]$q['index']
    if ($id -notmatch $idRe) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: id' }; return }
    if ($index -notmatch '^\d{1,3}$' -or [int]$index -lt 1) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: index' }; return }
    $r = Invoke-Outlook 'attachment' @{ id = $id; index = [int]$index } 120
  } else {
    Send-Json $ctx 404 @{ error = 'Unbekannter Endpunkt' }; return
  }
  if ($null -eq $r -or -not ($r -is [hashtable])) { Send-Json $ctx 502 @{ error = 'Outlook-Fehler: keine Antwort' } }
  elseif ($r.ContainsKey('error')) { Send-Json $ctx $r.status @{ error = [string]$r.error } }
  elseif ($r.ContainsKey('json')) { Send-Json $ctx $r.status $r.json }
  elseif ($r.ContainsKey('text')) { Send-Text $ctx $r.status $r.text }
  else {
    $ext = [IO.Path]::GetExtension([string]$r.name).ToLower()
    if ($mime.ContainsKey($ext)) { $type = $mime[$ext] } else { $type = 'application/octet-stream' }
    Send-Bytes $ctx $r.status $r.bytes $type
  }
}

function Send-Static($ctx) {
  $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
  if ($rel -eq '' -or $rel.EndsWith('/')) { $rel += 'index.html' }
  $file = $null
  try { $file = [IO.Path]::GetFullPath([IO.Path]::Combine($rootFull, $rel.Replace('/', '\'))) } catch { }
  # Pfad-Traversal: nur Dateien unterhalb von app\ (Trenner anhängen, sonst passte auch „app2\…“)
  if (-not $file -or -not $file.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($file)) {
    Send-Text $ctx 404 'not found'; return
  }
  $ext = [IO.Path]::GetExtension($file).ToLower()
  if ($mime.ContainsKey($ext)) { $type = $mime[$ext] } else { $type = 'application/octet-stream' }
  Send-Bytes $ctx 200 ([IO.File]::ReadAllBytes($file)) $type
}

while ($listener.IsListening) {
  $ctx = $null
  try { $ctx = $listener.GetContext() } catch { if (-not $listener.IsListening) { break } else { continue } }
  $isApi = $false
  try {
    $req = $ctx.Request
    $isApi = $req.Url.AbsolutePath.StartsWith('/api/', [StringComparison]::Ordinal)
    # Schutz gegen DNS-Rebinding: nur Host localhost/127.0.0.1 mit unserem Port
    if ($allowedHosts -notcontains ([string]$req.Headers['Host']).ToLower()) { Send-Text $ctx 403 'forbidden' }
    elseif ($isApi) { Handle-Api $ctx }
    else { Send-Static $ctx }
  } catch {
    # Fehler einer Anfrage beenden nie den Server
    $msg = [string]$_.Exception.Message
    try { Write-Host ("Fehler bei " + [string]$ctx.Request.Url.AbsolutePath + ": " + $msg) } catch { }
    try {
      if ($isApi) { Send-Json $ctx 500 @{ error = ('Interner Fehler: ' + $msg) } } else { Send-Text $ctx 500 'Interner Fehler' }
    } catch { }
  } finally {
    try { $ctx.Response.Close() } catch { }   # z. B. Browser hat Verbindung schon getrennt
  }
}
