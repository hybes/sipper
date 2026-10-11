import { statusLabel } from './labels'
import { workspaceRoles } from './workspace-invitation'

const auditLabels: Record<string, string> = {
  'workspace.created': 'Workspace created',
  'organisation.created': 'Customer added',
  'scim.token_rotated': 'Provisioning token created or rotated',
  'scim.token_revoked': 'Provisioning token revoked',
  'scim.user_created': 'User provisioned',
  'scim.user_linked': 'Provisioned identity verified',
  'scim.user_updated': 'Provisioned user updated',
  'scim.user_deleted': 'Provisioned user removed',
  'scim.group_created': 'Group provisioned',
  'scim.group_updated': 'Provisioned group updated',
  'scim.group_deleted': 'Provisioned group removed',
  'company_sign_in.created': 'Company sign-in configured',
  'company_sign_in.updated': 'Company sign-in credentials updated',
  'company_sign_in.domain_verified': 'Company sign-in domain verified',
  'company_sign_in.enabled': 'Company sign-in enabled',
  'company_sign_in.disabled': 'Company sign-in disabled',
  'invitation.created': 'Customer invitation queued',
  'invitation.accepted': 'Customer invitation accepted',
  'invitation.revoked': 'Customer invitation revoked',
  'workspace_invitation.created': 'Staff invitation queued',
  'workspace_invitation.revoked': 'Staff invitation revoked',
  'workspace_member.joined': 'Staff member joined',
  'workspace_member.role_changed': 'Staff role changed',
  'workspace_member.removed': 'Staff access removed',
  'seat.assigned': 'Licence assigned',
  'seat.released': 'Licence released',
  'member.resumed': 'Person resumed',
  'member.calling_preference_changed': 'Calling preference changed',
  'member.suspended': 'Person suspended',
  'member.role_changed': 'Customer role changed',
  'member.removed': 'Person removed from customer',
  'member.restored': 'Person rejoined customer',
  'sip_configuration.created': 'Calling account added',
  'sip_configuration.updated': 'Calling account updated',
  'sip_configuration.deleted': 'Calling account deleted',
  'sip_configuration.assigned': 'Calling account assigned',
  'sip_configuration.unassigned': 'Calling account unassigned',
  'device.enrolled': 'Device enrolled',
  'device.revoked': 'Device revoked',
  'directory_contact.created': 'Shared contact added',
  'directory_contact.updated': 'Shared contact updated',
  'directory_contact.deleted': 'Shared contact deleted',
  'group.created': 'Group created',
  'group.deleted': 'Group deleted',
  'group.members_updated': 'Group members updated',
  'group.configurations_updated': 'Group calling accounts updated',
  'billing.checkout_started': 'Checkout started',
  'billing.quantity_requested': 'Licence quantity requested',
  'billing.local_test_enabled': 'Local test licences updated',
  'setup_link.created': 'Setup link created',
  'setup_link.revoked': 'Setup link revoked',
  'setup_link.used': 'Setup link used',
}
export function auditLabel(action: string) {
  return auditLabels[action] ?? statusLabel(action.replaceAll('.', ' · '))
}
export function auditDetail(details: Record<string, unknown>) {
  const role = (value: unknown) => value === 'user' ? 'User' : workspaceRoles.find(item => item.value === value)?.label
  if (role(details.previousRole) && role(details.role)) return `${role(details.previousRole)} → ${role(details.role)}`
  if (role(details.role)) return role(details.role)
  if (role(details.previousRole)) return `Previously ${role(details.previousRole)}`
  if (typeof details.quantity === 'number') return `${details.quantity} licence${details.quantity === 1 ? '' : 's'}`
  if (typeof details.count === 'number') return `${details.count} selected`
  return ''
}
