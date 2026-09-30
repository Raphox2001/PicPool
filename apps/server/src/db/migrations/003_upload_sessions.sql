-- Protokoll der Upload-Sitzungen
--
-- Die Tabelle upload_sessions stand seit 001 im Schema, wurde aber nie
-- geschrieben. Damit fehlte genau die Haelfte der Diagnose: Fehlschlaege
-- meldet die Upload-Seite von selbst (audit_log, action = 'upload_failed'),
-- aber ein Upload, der still stehen bleibt, meldet gar nichts - die Seite ist
-- dann weg, bevor sie etwas sagen kann. Sichtbar wird so ein Abbruch erst,
-- wenn der Server weiss, wie viel vorgehabt war.
--
-- Deshalb hier: der Plan (was der Gast ausgewaehlt hat), die Bilanz (was
-- tatsaechlich angekommen ist) und ein Lebenszeichen. Bleibt last_seen_at
-- stehen, waehrend files_uploaded unter selected_files liegt, ist der Abbruch
-- am Datensatz allein erkennbar.

-- Was der Gast ausgewaehlt hat. Kommt von der Seite und ist damit unbestaetigt,
-- dient aber nur dem Vergleich mit dem, was der Server selbst gezaehlt hat.
ALTER TABLE upload_sessions ADD COLUMN selected_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_sessions ADD COLUMN selected_bytes INTEGER NOT NULL DEFAULT 0;

-- Endgueltig gescheiterte Dateien dieser Sitzung. Wird beim Fehlerbericht
-- mitgezaehlt, damit eine Zeile die ganze Geschichte erzaehlt.
ALTER TABLE upload_sessions ADD COLUMN failed_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upload_sessions ADD COLUMN last_error TEXT;

-- Gesetzt, wenn die Seite selbst "fertig" gemeldet hat. Fehlt es, obwohl alle
-- Dateien da sind, wurde die Seite vorher geschlossen - kein Fehler, aber ein
-- Unterschied, den man sehen will.
ALTER TABLE upload_sessions ADD COLUMN finished_at TEXT;

-- Fuer das Aufraeumen nach Ablauf der Aufbewahrungsfrist.
CREATE INDEX idx_upload_sessions_seen ON upload_sessions(last_seen_at);
