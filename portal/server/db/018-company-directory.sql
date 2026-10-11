ALTER TABLE organisations ADD COLUMN directory_revision uuid NOT NULL DEFAULT gen_random_uuid();
CREATE TABLE directory_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  company text NOT NULL DEFAULT '' CHECK (length(company)<=160),
  numbers jsonb NOT NULL CHECK (jsonb_typeof(numbers)='array' AND jsonb_array_length(numbers) BETWEEN 1 AND 5),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_contacts_page ON directory_contacts (organisation_id,lower(name),id);
