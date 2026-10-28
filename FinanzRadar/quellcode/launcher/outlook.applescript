-- FinanzRadar ↔ klassisches Outlook (Mac, „Legacy Outlook“). Aufruf nur durch server.py / server.mjs:
--   osascript outlook.applescript folders
--   osascript outlook.applescript messages <ordnerId> <JJJJ-MM-TT>
--   osascript outlook.applescript attachments <mailId> [<mailId> …]
--   osascript outlook.applescript body <mailId>
--   osascript outlook.applescript save <mailId> <index> <zielpfad>
-- Alle Werte kommen als Argumente (keine Code-Erzeugung). Ausgabe: Datensätze mit ASCII 30, Felder mit ASCII 31 getrennt.
-- „New Outlook“ unterstützt kein AppleScript – das prüft der Server vorher.

property RS : character id 30
property US : character id 31

on run argv
	set cmd to item 1 of argv
	if cmd is "folders" then return my listFolders()
	if cmd is "messages" then return my listMessages(item 2 of argv, item 3 of argv)
	if cmd is "attachments" then return my listAttachments(rest of argv)
	if cmd is "body" then return my mailBody(item 2 of argv)
	if cmd is "save" then return my saveAttachment(item 2 of argv, item 3 of argv, item 4 of argv)
	error "Unbekannter Befehl: " & cmd
end run

-- Steuerzeichen der Trenner aus Texten entfernen
on clean(t)
	if t is missing value then return ""
	set t to t as text
	set AppleScript's text item delimiters to {RS, US}
	set parts to text items of t
	set AppleScript's text item delimiters to " "
	set t to parts as text
	set AppleScript's text item delimiters to ""
	return t
end clean

on pad(n)
	set s to (n as integer) as text
	if length of s < 2 then set s to "0" & s
	return s
end pad

on iso(d)
	return ((year of d) as integer as text) & "-" & my pad((month of d) as integer) & "-" & my pad(day of d) & "T" & my pad(hours of d) & ":" & my pad(minutes of d) & ":" & my pad(seconds of d)
end iso

-- "JJJJ-MM-TT" → date (lokal, 00:00); Tag zuerst auf 1, damit kein Monatsüberlauf entsteht
on mkDate(s)
	set d to current date
	set day of d to 1
	set year of d to (text 1 thru 4 of s) as integer
	set month of d to (text 6 thru 7 of s) as integer
	set day of d to (text 9 thru 10 of s) as integer
	set time of d to 0
	return d
end mkDate

on joinRecords(lst)
	set AppleScript's text item delimiters to RS
	set out to lst as text
	set AppleScript's text item delimiters to ""
	return out
end joinRecords

-- Ordner: id US name US pfad US anzahl US posteingang(1/0)
on listFolders()
	set out to {}
	set inboxIds to {}
	tell application "Microsoft Outlook"
		try
			set end of inboxIds to (id of inbox) as text
		end try
		repeat with accts in {exchange accounts, imap accounts, pop accounts}
			try
				repeat with a in (contents of accts)
					try
						set end of inboxIds to (id of (inbox of a)) as text
					end try
				end repeat
			end try
		end repeat
		set tops to {}
		repeat with f in (mail folders)
			set isTop to true
			try
				if class of (container of f) is mail folder then set isTop to false
			end try
			if isTop then set end of tops to contents of f
		end repeat
	end tell
	my walk(tops, "", out, inboxIds, 0)
	return my joinRecords(out)
end listFolders

on walk(fs, prefix, out, inboxIds, depth)
	if depth > 12 then return
	tell application "Microsoft Outlook"
		repeat with f in fs
			set fid to (id of f) as text
			set n to my clean(name of f)
			set p to prefix & n
			set c to 0
			try
				set c to count messages of f
			end try
			set isInbox to "0"
			if inboxIds contains fid then set isInbox to "1"
			set end of out to fid & US & n & US & p & US & (c as text) & US & isInbox
			set subs to {}
			try
				set subs to mail folders of f
			end try
			if (count of subs) > 0 then my walk(subs, p & "/", out, inboxIds, depth + 1)
		end repeat
	end tell
end walk

-- Absender-Record {name, address} → "Name <adresse>"
on senderText(s)
	set fromText to ""
	tell application "Microsoft Outlook"
		try
			set fromText to my clean(name of s)
		end try
		try
			set addr to address of s
			if addr is not missing value and addr is not "" then
				if fromText is "" then
					set fromText to my clean(addr)
				else
					set fromText to fromText & " <" & my clean(addr) & ">"
				end if
			end if
		end try
	end tell
	return fromText
end senderText

-- Mails ab Datum: id US betreff US absender US datum (ohne Anhänge; die holt „attachments“ gezielt für die neuesten).
-- Erst als Sammelabfrage (wenige Apple Events, schnell), bei Problemen einzeln.
on listMessages(fid, sinceStr)
	set d to my mkDate(sinceStr)
	set out to {}
	tell application "Microsoft Outlook"
		set f to mail folder id (fid as integer)
		try
			set ids to id of (every message of f whose time received ≥ d)
			set subs to subject of (every message of f whose time received ≥ d)
			set times to time received of (every message of f whose time received ≥ d)
			set snds to sender of (every message of f whose time received ≥ d)
			set n to count of ids
			if (count of subs) = n and (count of times) = n and (count of snds) = n then
				repeat with i from 1 to n
					set end of out to ((item i of ids) as text) & US & my clean(item i of subs) & US & my senderText(item i of snds) & US & my iso(item i of times)
				end repeat
				return my joinRecords(out)
			end if
		end try
		set out to {}
		set ms to (every message of f whose time received ≥ d)
		repeat with m in ms
			try
				set fromText to ""
				try
					set fromText to my senderText(sender of m)
				end try
				set end of out to ((id of m) as text) & US & my clean(subject of m) & US & fromText & US & my iso(time received of m)
			end try
		end repeat
	end tell
	return my joinRecords(out)
end listMessages

-- Anhänge: mailId US index US name US größe
on listAttachments(ids)
	set out to {}
	tell application "Microsoft Outlook"
		repeat with mid in ids
			try
				set m to message id ((contents of mid) as integer)
				set atts to attachments of m
				set i to 0
				repeat with a in atts
					set i to i + 1
					set sz to 0
					try
						set sz to file size of a
					end try
					set end of out to ((contents of mid) as text) & US & (i as text) & US & my clean(name of a) & US & (sz as text)
				end repeat
			end try
		end repeat
	end tell
	return my joinRecords(out)
end listAttachments

-- Mailtext: betreff US absender US datum US text (Klartext, sonst HTML – der Server entfernt Tags)
on mailBody(mid)
	tell application "Microsoft Outlook"
		set m to message id (mid as integer)
		set subj to my clean(subject of m)
		set fromText to ""
		try
			set fromText to my senderText(sender of m)
		end try
		set txt to ""
		set isHtml to "0"
		try
			set txt to plain text content of m
		end try
		if txt is missing value or txt is "" then
			try
				set txt to content of m
				set isHtml to "1"
			end try
		end if
		if txt is missing value then set txt to ""
		return subj & US & fromText & US & my iso(time received of m) & US & isHtml & US & my clean(txt)
	end tell
end mailBody

-- Anhang Nr. idx (ab 1) nach zielpfad speichern
on saveAttachment(mid, idx, dest)
	tell application "Microsoft Outlook"
		set m to message id (mid as integer)
		set a to attachment (idx as integer) of m
		try
			save a in (POSIX file dest)
		on error
			save a in ((POSIX file dest) as text)
		end try
	end tell
	return "ok"
end saveAttachment
