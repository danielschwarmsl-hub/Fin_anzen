# Minimaler statischer Webserver für FinanzRadar (nur localhost), ohne Installation.
# Dazu die Outlook-Brücke unter /api/outlook/* für das klassische Outlook (Desktop, COM).
# „Neues Outlook“ hat keine COM-Schnittstelle – dann meldet /api/outlook/status available=false mit Grund.
$port = 8765
$root = Join-Path $PSScriptRoot 'app'
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "FinanzRadar laeuft auf http://localhost:$port/  (Fenster offen lassen)"
Start-Process "http://localhost:$port/"
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript'; '.mjs'='text/javascript'; '.css'='text/css'; '.json'='application/json'; '.svg'='image/svg+xml'; '.png'='image/png'; '.jpg'='image/jpeg'; '.jpeg'='image/jpeg'; '.gif'='image/gif'; '.webp'='image/webp'; '.heic'='image/heic'; '.tif'='image/tiff'; '.tiff'='image/tiff'; '.wasm'='application/wasm'; '.gz'='application/gzip'; '.pdf'='application/pdf'; '.csv'='text/csv'; '.xml'='application/xml'; '.txt'='text/plain; charset=utf-8'; '.xlsx'='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; '.xls'='application/vnd.ms-excel'; '.pfb'='application/octet-stream'; '.ttf'='font/ttf' }
$allowedHosts = @("localhost:$port", "127.0.0.1:$port")
$utf8 = New-Object System.Text.UTF8Encoding($false)

# ---- Outlook-Zugriff: läuft je Anfrage in eigenem STA-Runspace, damit ein Zeitlimit greifen kann ----
# Ergebnis immer als Hashtable: @{ status; json } | @{ status; text } | @{ status; bytes; name } | @{ status; error }
$outlookWorker = {
  param($cmd, $a)
  $ErrorActionPreference = 'Stop'
  $inv = [Globalization.CultureInfo]::InvariantCulture
  function Fail($status, $msg) { throw ("FR{0}|{1}" -f $status, $msg) }
  function IsoDate($d) { ([datetime]$d).ToString("yyyy-MM-dd'T'HH:mm:ss", $inv) }
  function Split-Id($id) {
    $p = $id.Split('.')
    if ($p.Count -eq 2) { return $p } else { return @($p[0], $null) }
  }
  function Get-Message($ns, $id) {
    $p = Split-Id $id
    try { $m = if ($p[1]) { $ns.GetItemFromID($p[0], $p[1]) } else { $ns.GetItemFromID($p[0]) } } catch { Fail 404 'Mail nicht gefunden (gelöscht oder verschoben?)' }
    return $m
  }
  function Sender-Text($m) {
    $name = [string]$m.SenderName
    $addr = ''
    try {
      if ($m.SenderEmailType -eq 'EX') { $addr = [string]$m.Sender.GetExchangeUser().PrimarySmtpAddress } else { $addr = [string]$m.SenderEmailAddress }
    } catch { }
    if ($addr -and $name -and $addr -ne $name) { return "$name <$addr>" }
    if ($addr) { return $addr }
    return $name
  }

  try {
    $ol = New-Object -ComObject Outlook.Application
    $ns = $ol.GetNamespace('MAPI')
    switch ($cmd) {
      'folders' {
        $inboxId = ''
        try { $inboxId = [string]$ns.GetDefaultFolder(6).EntryID } catch { }
        $out = New-Object System.Collections.ArrayList
        function Walk($folders, $prefix, $depth) {
          if ($depth -gt 12) { return }
          foreach ($f in $folders) {
            try {
              if ($f.DefaultItemType -ne 0) { continue }   # nur Mail-Ordner (olMailItem)
              $name = [string]$f.Name
              $path = $prefix + $name
              $count = 0
              try { $count = [int]$f.Items.Count } catch { }
              [void]$out.Add([pscustomobject]@{ id = ([string]$f.EntryID + '.' + [string]$f.StoreID); name = $name; path = $path; count = $count; inbox = ([string]$f.EntryID -eq $inboxId) })
              Walk $f.Folders ($path + '/') ($depth + 1)
            } catch { }
          }
        }
        Walk $ns.Folders '' 0
        return @{ status = 200; json = $out }
      }
      'messages' {
        $p = Split-Id $a.folder
        try { $f = if ($p[1]) { $ns.GetFolderFromID($p[0], $p[1]) } else { $ns.GetFolderFromID($p[0]) } } catch { Fail 404 'Ordner nicht gefunden' }
        $store = [string]$f.StoreID
        $since = [datetime]::ParseExact($a.since, 'yyyy-MM-dd', $inv)
        $items = $f.Items
        $restricted = $true
        try {
          # Jet-Filter erwartet das Datum im Format der Systemsprache
          $r = $items.Restrict("[ReceivedTime] >= '" + $since.ToString('g') + "'")
        } catch { $r = $items; $restricted = $false }
        $r.Sort('[ReceivedTime]', $true)
        $out = New-Object System.Collections.ArrayList
        foreach ($m in $r) {
          if ($out.Count -ge $a.limit) { break }
          try {
            if ($m.Class -ne 43) { continue }   # nur E-Mails (olMail)
            $rt = [datetime]$m.ReceivedTime
            if ($rt -lt $since) { if ($restricted) { continue } else { break } }
            $atts = New-Object System.Collections.ArrayList
            $n = $m.Attachments.Count
            for ($i = 1; $i -le $n; $i++) {
              try {
                $at = $m.Attachments.Item($i)
                [void]$atts.Add([pscustomobject]@{ index = $i; name = [string]$at.FileName; size = [int64]$at.Size })
              } catch { }
            }
            [void]$out.Add([pscustomobject]@{ id = ([string]$m.EntryID + '.' + $store); subject = [string]$m.Subject; from = (Sender-Text $m); date = (IsoDate $rt); hasBody = $true; attachments = [object[]]$atts.ToArray() })
          } catch { }
        }
        return @{ status = 200; json = $out }
      }
      'body' {
        $m = Get-Message $ns $a.id
        $text = [string]$m.Body
        $head = "Von: " + (Sender-Text $m) + "`nBetreff: " + [string]$m.Subject + "`nDatum: " + ([datetime]$m.ReceivedTime).ToString('dd.MM.yyyy HH:mm', $inv)
        return @{ status = 200; text = ($head + "`n`n" + ($text -replace "`r`n", "`n").Trim()) }
      }
      'attachment' {
        $m = Get-Message $ns $a.id
        if ($a.index -gt $m.Attachments.Count) { Fail 404 'Anhang nicht gefunden' }
        $at = $m.Attachments.Item($a.index)
        $name = [string]$at.FileName
        $safe = ($name -replace '[\\/:*?"<>|\x00-\x1f]', '_').Trim('. ')
        if (-not $safe) { $safe = "Anhang$($a.index)" }
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ('finanzradar-' + [guid]::NewGuid().ToString('N'))
        [void](New-Item -ItemType Directory -Path $tmp)
        try {
          $dest = Join-Path $tmp $safe
          $at.SaveAsFile($dest)
          $bytes = [IO.File]::ReadAllBytes($dest)
        } finally {
          Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
        }
        return @{ status = 200; bytes = $bytes; name = $name }
      }
      default { Fail 404 'Unbekannter Endpunkt' }
    }
  } catch {
    $msg = [string]$_.Exception.Message
    if ($msg -match '^FR(\d{3})\|(.*)$') { return @{ status = [int]$Matches[1]; error = $Matches[2] } }
    $hr = $_.Exception.HResult
    if ($hr -eq -2147221164 -or $msg -match '80040154') { return @{ status = 503; error = 'Klassisches Outlook ist nicht installiert („Neues Outlook“ unterstützt keine Anbindung).' } }
    if ($hr -eq -2146959355 -or $msg -match '80080005') { return @{ status = 503; error = 'Outlook und FinanzRadar laufen mit unterschiedlichen Rechten – beide normal (nicht als Administrator) starten.' } }
    return @{ status = 502; error = ('Outlook-Fehler: ' + $msg) }
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
  if ($bytes.Length) { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
}
function Send-Json($ctx, [int]$status, $obj) {
  Send-Bytes $ctx $status $utf8.GetBytes((ConvertTo-Json -InputObject $obj -Depth 6 -Compress)) 'application/json; charset=utf-8'
}

function Test-OutlookInstalled {
  return (Test-Path 'Registry::HKEY_CLASSES_ROOT\Outlook.Application\CLSID')
}

function Invoke-Outlook([string]$cmd, [hashtable]$a, [int]$timeoutSec) {
  $rs = [RunspaceFactory]::CreateRunspace()
  $rs.ApartmentState = 'STA'
  $rs.Open()
  $ps = [PowerShell]::Create()
  $ps.Runspace = $rs
  [void]$ps.AddScript($outlookWorker.ToString()).AddArgument($cmd).AddArgument($a)
  $h = $ps.BeginInvoke()
  if (-not $h.AsyncWaitHandle.WaitOne($timeoutSec * 1000)) {
    [void]$ps.BeginStop($null, $null)   # Runspace bleibt ggf. hängen – Antwort trotzdem sofort
    return @{ status = 504; error = 'Outlook antwortet nicht (Zeitlimit überschritten).' }
  }
  try {
    $out = $ps.EndInvoke($h)
    if ($out.Count -gt 0) {
      $last = $out[$out.Count - 1]
      if ($null -ne $last -and $last.psobject.BaseObject -is [hashtable]) { return $last.psobject.BaseObject }
    }
    $err = if ($ps.Streams.Error.Count) { [string]$ps.Streams.Error[0] } else { 'keine Antwort' }
    return @{ status = 502; error = ('Outlook-Fehler: ' + $err) }
  } catch {
    return @{ status = 502; error = ('Outlook-Fehler: ' + $_.Exception.Message) }
  } finally {
    $ps.Dispose()
    $rs.Close()
  }
}

function Handle-Api($ctx) {
  $req = $ctx.Request
  # Nur die eigene Seite darf fragen (keine CORS-Header; zusätzlich Fetch-Metadaten/Origin prüfen)
  $site = $req.Headers['Sec-Fetch-Site']
  $origin = $req.Headers['Origin']
  if (($site -and $site -ne 'same-origin' -and $site -ne 'none') -or ($origin -and -not ($allowedHosts | Where-Object { "http://$_" -eq $origin.ToLower() }))) {
    Send-Json $ctx 403 @{ error = 'Nur von FinanzRadar selbst erlaubt' }; return
  }
  if ($req.HttpMethod -ne 'GET') { Send-Json $ctx 405 @{ error = 'Nur GET' }; return }
  $q = $req.QueryString
  $idRe = '^[0-9A-Fa-f]{2,1024}(\.[0-9A-Fa-f]{2,2048})?$'
  $route = $req.Url.AbsolutePath
  if ($route -eq '/api/outlook/status') {
    if (Test-OutlookInstalled) { Send-Json $ctx 200 @{ available = $true; platform = 'windows' } }
    else { Send-Json $ctx 200 @{ available = $false; platform = 'windows'; reason = 'Klassisches Outlook ist nicht installiert („Neues Outlook“ unterstützt keine Anbindung).' } }
    return
  }
  $r = $null
  switch ($route) {
    '/api/outlook/folders' { $r = Invoke-Outlook 'folders' @{} 120 }
    '/api/outlook/messages' {
      $folder = [string]$q['folder']; $since = [string]$q['since']; $limit = [string]$q['limit']
      if ($folder -notmatch $idRe) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: folder' }; return }
      if (-not $since) { $since = (Get-Date).AddYears(-1).ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
      $d = [datetime]::MinValue
      if ($since -notmatch '^\d{4}-\d{2}-\d{2}$' -or -not [datetime]::TryParseExact($since, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, 'None', [ref]$d)) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: since' }; return }
      if (-not $limit) { $limit = '500' }
      if ($limit -notmatch '^\d{1,6}$' -or [int]$limit -lt 1 -or [int]$limit -gt 5000) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: limit' }; return }
      $r = Invoke-Outlook 'messages' @{ folder = $folder; since = $since; limit = [int]$limit } 180
    }
    '/api/outlook/body' {
      $id = [string]$q['id']
      if ($id -notmatch $idRe) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: id' }; return }
      $r = Invoke-Outlook 'body' @{ id = $id } 60
    }
    '/api/outlook/attachment' {
      $id = [string]$q['id']; $index = [string]$q['index']
      if ($id -notmatch $idRe) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: id' }; return }
      if ($index -notmatch '^\d{1,3}$' -or [int]$index -lt 1) { Send-Json $ctx 400 @{ error = 'Ungültiger Parameter: index' }; return }
      $r = Invoke-Outlook 'attachment' @{ id = $id; index = [int]$index } 120
    }
    default { Send-Json $ctx 404 @{ error = 'Unbekannter Endpunkt' }; return }
  }
  if ($r.error) { Send-Json $ctx $r.status @{ error = $r.error } }
  elseif ($r.ContainsKey('json')) { Send-Json $ctx $r.status $r.json }
  elseif ($r.ContainsKey('text')) { Send-Bytes $ctx $r.status $utf8.GetBytes($r.text) 'text/plain; charset=utf-8' }
  else {
    $ext = [IO.Path]::GetExtension($r.name).ToLower()
    Send-Bytes $ctx $r.status $r.bytes $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
  }
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    # Schutz gegen DNS-Rebinding: nur Host localhost/127.0.0.1 mit unserem Port
    if ($allowedHosts -notcontains ([string]$ctx.Request.Headers['Host']).ToLower()) { $ctx.Response.StatusCode = 403; continue }
    if ($ctx.Request.Url.AbsolutePath.StartsWith('/api/')) { Handle-Api $ctx; continue }
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($path -eq '') { $path = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $path))
    if (-not $file.StartsWith([IO.Path]::GetFullPath($root)) -or -not (Test-Path $file -PathType Leaf)) { $ctx.Response.StatusCode = 404; continue }
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $ctx.Response.ContentType = $(if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' })
    $bytes = [IO.File]::ReadAllBytes($file)
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    try { if ($ctx.Request.Url.AbsolutePath.StartsWith('/api/')) { Send-Json $ctx 500 @{ error = ('Interner Fehler: ' + $_.Exception.Message) } } } catch { }
  } finally { $ctx.Response.Close() }
}
