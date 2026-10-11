-- The restore tool marks this singleton inside the same transaction as the
-- restored data. An unsuccessful restore leaves no usable application schema.
CREATE TABLE service_recovery (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  restored_at timestamptz,
  released_at timestamptz,
  CHECK (released_at IS NULL OR (restored_at IS NOT NULL AND released_at>=restored_at))
);
INSERT INTO service_recovery(singleton) VALUES (true);
