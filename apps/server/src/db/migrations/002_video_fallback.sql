-- Video-Fallback
--
-- Manche Browser koennen die Codecs nicht abspielen, die Handys aufnehmen.
-- Der wichtigste Fall ist HEVC vom iPhone: Safari spielt es, Firefox nicht,
-- Chrome nur je nach Geraet. Fuer solche Videos kann eine H.264-Fassung
-- erzeugt werden, die praktisch ueberall laeuft.
--
-- Bewusst nicht automatisch fuer alles: Die DS923+ hat keine iGPU, also
-- keine Hardware-Unterstuetzung. Jede Umwandlung ist reine CPU-Arbeit auf
-- zwei Kernen und dauert laenger als das Video selbst.

-- Der ermittelte Codec wurde bisher gelesen, aber nicht abgelegt. Ohne ihn
-- laesst sich nicht entscheiden, ob eine Aufbereitung noetig ist.
ALTER TABLE assets ADD COLUMN video_codec TEXT;

-- Stand der Aufbereitung je Video:
--   NULL        nicht noetig oder noch nicht betrachtet
--   pending     eingereiht
--   running     laeuft gerade
--   ready       H.264-Fassung liegt vor
--   failed      Umwandlung fehlgeschlagen
--   skipped     bewusst uebersprungen (zu lang, oder abgeschaltet)
ALTER TABLE assets ADD COLUMN transcode_status TEXT;

-- Pro Album einstellbar, weil der Aufwand erheblich ist.
ALTER TABLE albums ADD COLUMN transcode_videos INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_assets_transcode
  ON assets(album_id, transcode_status) WHERE deleted_at IS NULL;
