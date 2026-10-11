-- Per-process observations, never hostnames, queue payloads or provider errors.
CREATE TABLE worker_progress (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('email','push')),
  started_at timestamptz NOT NULL DEFAULT now(),
  progressed_at timestamptz,
  stopped_at timestamptz
);
