-- Trail Marker: remember which pairing attempt minted each linked Mac (#2560).
--
-- Cancelling from the Mac must undo the whole link, not only the request. Without this
-- column a Mac that redeemed a credential a moment before the person hit Cancel keeps
-- working, and nobody at the browser sees why. With it, cancel deletes the device row
-- in the same transaction as the attempt.
--
-- The column is nullable because attempts are deleted once they expire, and a linked Mac
-- outlives the request that created it.

ALTER TABLE app.companion_devices
  ADD COLUMN pair_attempt_id uuid
    REFERENCES app.companion_pair_attempts (id) ON DELETE SET NULL;

CREATE INDEX companion_devices_pair_attempt_id_idx
  ON app.companion_devices (pair_attempt_id);
