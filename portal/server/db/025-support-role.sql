ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner', 'admin', 'billing', 'support'));
ALTER TABLE workspace_invitations DROP CONSTRAINT workspace_invitations_role_check;
ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_role_check
  CHECK (role IN ('owner', 'admin', 'billing', 'support'));
